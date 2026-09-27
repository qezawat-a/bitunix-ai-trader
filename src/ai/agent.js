import ai from './providers.js';
import { buildSystemPrompt, loadSkillFiles } from './soul.js';
import { toolSchemas, runTool, TOOL_MAP } from './tools.js';
import { createLogger } from '../logger.js';
import { config } from '../config.js';
import * as db from '../db/index.js';
import { portfolioSnapshot } from '../trading/manager.js';

const log = createLogger('agent');

const THINK_STEPS = { off: 1, low: 3, medium: 6, high: 10 };

/**
 * The agent: a real reasoning loop with tools, long-term memory,
 * conversation compaction and configurable thinking depth.
 */
export class Agent {
  constructor() { this.busy = new Map(); }

  /** Compact old conversation into a summary so context never overflows. */
  async autocompact(chatId) {
    const s = db.settings();
    if (!s.autocompact) return null;

    // Memory is a nice-to-have. If Neon is unreachable the agent must still
    // answer — degraded, not dead.
    let summary, since, pending, msgs;
    try {
      summary = await db.latestSummary(chatId);
      since = summary?.covers_until || 0;
      pending = await db.countMessagesSince(chatId, since);
      if (pending < 60) return summary?.summary || null;
      msgs = await db.recentMessages(chatId, 120);
    } catch (e) {
      log.warn(`autocompact: memory unavailable (${e.message}) — continuing without it`);
      return null;
    }

    const text = msgs.map((m) => `${m.role}: ${String(m.content).slice(0, 500)}`).join('\n');
    try {
      const r = await ai.chat({
        thinking: 'low', maxTokens: 900, temperature: 0.1,
        messages: [
          { role: 'system', content: 'Compress this trading-agent conversation into a dense factual briefing: user preferences and standing instructions, settings the user changed, trades discussed and their outcomes, unresolved threads. No pleasantries. Bullet points.' },
          { role: 'user', content: (summary ? `Previous summary:\n${summary.summary}\n\nNew messages:\n` : '') + text },
        ],
      });
      const lastId = msgs[msgs.length - 1]?.id || since;
      await db.saveSummary(chatId, r.content, lastId);
      log.info(`autocompact: folded ${pending} messages`);
      return r.content;
    } catch (e) {
      log.warn(`autocompact failed: ${e.message}`);
      return summary?.summary || null;
    }
  }

  /**
   * soul/ is read from disk on every prompt build, so there is no cache to
   * bust — this simply reports what is currently active (and gives /reload
   * something honest to say).
   */
  reloadSoul() {
    const files = loadSkillFiles();
    const on = files.filter((f) => f.enabled);
    log.info(`soul reloaded — ${on.length}/${files.length} extra skill(s) active${on.length ? ': ' + on.map((f) => f.file).join(', ') : ''}`);
    return on;
  }

  async buildContext(chatId, { subject = null } = {}) {
    const s = db.settings();
    const summary = await this.autocompact(chatId).catch(() => null);
    const [memories, portfolio] = await Promise.all([
      db.recall({ subject, limit: 14 }).catch(() => []),
      portfolioSnapshot().catch(() => null),
    ]);
    return buildSystemPrompt({
      settings: s, memories, summary, portfolio, providerStatus: ai.status(),
    });
  }

  /**
   * One full agentic turn: think -> call tools -> observe -> ... -> answer.
   */
  async run({ chatId, userMessage, subject = null, thinking = null, extraSystem = null, persist = true, onStep = null }) {
    const s = db.settings();
    const level = thinking || s.thinking_level || config.ai.thinkingLevel;
    const maxSteps = THINK_STEPS[String(level).toLowerCase()] ?? 6;

    const system = await this.buildContext(chatId, { subject });
    const history = persist ? await db.recentMessages(chatId, 24).catch(() => []) : [];

    const messages = [{ role: 'system', content: system }];
    if (extraSystem) messages.push({ role: 'system', content: extraSystem });
    for (const h of history) {
      if (h.role === 'tool') continue;
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
    }
    messages.push({ role: 'user', content: userMessage });

    if (persist) await db.saveMessage({ chatId, role: 'user', content: userMessage }).catch(() => {});

    const schemas = toolSchemas();
    const trace = [];
    let final = '';

    for (let step = 0; step < maxSteps; step++) {
      let res;
      try {
        res = await ai.chat({ messages, tools: schemas, thinking: level, maxTokens: 2500 });
      } catch (e) {
        final = `⚠️ AI layer failed: ${e.message}`;
        break;
      }

      if (!res.toolCalls?.length) {
        final = res.content || '(no answer)';
        break;
      }

      // The text that comes back ALONGSIDE tool calls is the model thinking out
      // loud ("Let me check positions first..."). It is scaffolding, not an
      // answer — keep it in the transcript for the model, surface it only as a
      // step, never as the reply.
      if (res.content?.trim() && onStep) {
        await onStep({ type: 'thought', text: res.content.trim() });
      }

      // record the assistant's tool-call turn in provider-neutral shape
      messages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.toolCalls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });

      for (const call of res.toolCalls) {
        const danger = TOOL_MAP[call.name]?.danger;
        log.info(`${danger ? '⚡' : '·'} tool ${call.name} ${JSON.stringify(call.args).slice(0, 160)}`);
        if (onStep) await onStep({ type: 'tool', name: call.name, args: call.args, danger });

        const out = await runTool(call.name, call.args);
        trace.push({ tool: call.name, args: call.args, result: out });

        const serialised = JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 12000);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: serialised });
        if (persist) {
          await db.saveMessage({
            chatId, role: 'tool', content: serialised.slice(0, 4000),
            toolName: call.name, meta: { args: call.args },
          }).catch(() => {});
        }
      }

      if (step === maxSteps - 1) {
        messages.push({ role: 'user', content: 'You have used all your tool steps. Give your final answer now, based on what you already know.' });
        try {
          const r = await ai.chat({ messages, thinking: 'low', maxTokens: 1500 });
          final = r.content;
        } catch (e) { final = `⚠️ ${e.message}`; }
      }
    }

    if (persist && final) await db.saveMessage({ chatId, role: 'assistant', content: final }).catch(() => {});
    return { text: final, trace, thinking: level };
  }

  /**
   * Autonomous decision on a scanner signal.
   * The agent is the final gate — the mechanical gates only decide what reaches it.
   */
  async judgeSignal(signal, { chatId = 'autonomous' } = {}) {
    const s = db.settings();
    const memories = await db.recall({ subject: signal.symbol, limit: 8 });
    const memText = memories.length
      ? memories.map((m) => `- ${m.content}`).join('\n')
      : '(no prior memory for this symbol)';

    const prompt = `A consensus signal just passed every mechanical gate. Decide whether to actually take it.

SIGNAL
  symbol      ${signal.symbol}
  side        ${signal.side}
  confidence  ${signal.confidence} (raw ${signal.rawConfidence}) — gate is ${s.min_confidence}
  agreement   ${signal.agreement}/6 — gate is ${s.min_agreement}
  regime      ${signal.regime}   (higher TF: ${signal.htfRegime})
  price       ${signal.price}
  ATR%        ${signal.atrPct?.toFixed(3)}
  funding     ${signal.funding}
  strategies  ${signal.strategies.map((x) => `${x.name}@${x.confidence} [${x.timeframes.join(',')}]`).join(' | ')}
  opposing    ${signal.opposite.agreement} strategies vote ${signal.opposite.side} at ${signal.opposite.confidence}
  flags       ${signal.flags.join('; ') || 'none'}

WHAT I REMEMBER ABOUT ${signal.symbol}
${memText}

You may call tools to check the book, funding history, your own recent performance, or current exposure before deciding.
Then reply with ONLY a JSON object:
{"take": true|false, "confidence": 0-100, "margin_usdt": null|number, "reasoning": "one or two sentences"}`;

    const r = await this.run({
      chatId, userMessage: prompt, subject: signal.symbol,
      persist: false, thinking: s.thinking_level,
    });

    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return { take: false, reasoning: `could not parse verdict: ${r.text.slice(0, 200)}`, raw: r.text };
    try {
      const v = JSON.parse(m[0]);
      return { take: Boolean(v.take), confidence: v.confidence, marginUsdt: v.margin_usdt ?? null, reasoning: v.reasoning || '', raw: r.text };
    } catch (e) {
      return { take: false, reasoning: `bad JSON: ${e.message}`, raw: r.text };
    }
  }

  /** Free-running heartbeat thought — lets the agent act on its own initiative. */
  /**
   * A background cycle. This runs every few seconds forever, so the bar for
   * SAYING something is much higher than the bar for CHECKING something.
   *
   * Two rules make it liveable:
   *  - it must answer NOOP unless it actually did something or something is
   *    genuinely wrong;
   *  - it will not repeat a message it already sent recently.
   */
  async autonomousTick({ chatId = 'autonomous', notify = null }) {
    const s = db.settings();

    const prompt = `Autonomous background check. You are talking to NOBODY — this is a timer, not a question from the user.

Check with tools, do not assume:
1. Open positions — in trouble, missing protection, or is the stop due to move?
2. Exposure — too much risk on correlated symbols, too many positions?
3. Anything the scanner flagged that deserves a second look.

Then choose ONE:
- You changed something (moved a stop, closed, opened, adjusted): say what you did and why, in one short paragraph.
- Something is genuinely wrong and the user must know NOW: say it in one line.
- Anything else — including "all good", "monitoring", "nothing to do", or a
  situation you already reported: reply with exactly NOOP and nothing else.

Do not greet. Do not ask questions — nobody is reading this in real time. Do not
narrate that you are checking. Silence is the correct and normal outcome.`;

    const r = await this.run({
      chatId, userMessage: prompt, persist: false,
      thinking: s.thinking_level === 'high' ? 'medium' : s.thinking_level,
    });

    const text = (r.text || '').trim();
    if (!text || /^NOOP/i.test(text)) return { acted: false };

    // Belt and braces: models drift into "everything looks fine" no matter how
    // the prompt is worded. If it took no action and said nothing alarming,
    // treat it as NOOP.
    const tookAction = (r.trace || []).some((t) => TOOL_MAP[t.tool]?.danger);
    const CHATTER = /^(all (is |looks )?(good|fine|well)|nothing (to do|needs|to report)|no action|monitoring|standing by|everything (is )?(fine|ok|normal|stable)|position[s]? (are|look) (fine|healthy|ok))/i;
    if (!tookAction && CHATTER.test(text)) return { acted: false, suppressed: 'chatter' };

    // Do not say the same thing twice in a row.
    const fingerprint = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
    if (fingerprint && fingerprint === this._lastAutonomous?.fingerprint
        && Date.now() - this._lastAutonomous.at < 30 * 60_000) {
      return { acted: false, suppressed: 'duplicate' };
    }
    this._lastAutonomous = { fingerprint, at: Date.now() };

    if (notify) await notify(`🧠 ${text}`);
    await db.logEvent('autonomous_action', { text: text.slice(0, 1000) }).catch(() => {});
    return { acted: true, text, trace: r.trace };
  }
}

export const agent = new Agent();
export default agent;
