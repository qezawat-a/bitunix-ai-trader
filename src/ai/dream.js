import ai from './providers.js';
import { createLogger } from '../logger.js';
import * as db from '../db/index.js';
import { bold, italic } from '../telegram/format.js';

const log = createLogger('dream');

/**
 * DREAM — offline reflection.
 *
 * Everything the agent learns while trading arrives one trade at a time, as a
 * single lesson attached to a single symbol. That is the wrong granularity to
 * learn from: a hundred BTC lessons do not say "we systematically take
 * mean-reversion entries in a trending tape", which is the kind of thing that
 * actually changes behaviour.
 *
 * So dream does what the name says. Off-hours, with nothing to execute, it
 * reads a window of its own recent experience — closed trades, the strategy
 * weights they produced, the memories it wrote — and asks one question:
 * what is the PATTERN, and what should change because of it?
 *
 * It writes findings back as high-importance memories. It never trades, never
 * changes a setting and never opens a position: dream is allowed to think,
 * not to act. Anything that would move money is a decision for the next scan.
 */

const WINDOW_DAYS = 7;

/** Everything dream is allowed to look at, in one prompt-sized blob. */
export async function gather(chatId = 'dream') {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const [trades, stats, memories, signals] = await Promise.all([
    db.tradeStats(WINDOW_DAYS).catch(() => null),
    db.pool.query(
      `SELECT strategy, wins, losses, pnl, weight FROM strategy_stats
        ORDER BY (wins::numeric - losses) DESC NULLS LAST`),
    db.recall({ limit: 40 }).catch(() => []),
    db.pool.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE taken)::int AS taken,
              avg(confidence)::numeric AS avg_conf,
              avg(agreement)::numeric AS avg_agree
         FROM signals WHERE created_at > $1`, [since]),
  ]).catch((e) => { log.warn(`gather: ${e.message}`); return null; });

  if (!trades) return null;

  const recent = await db.pool.query(
    `SELECT symbol, side, confidence, agreement, strategies, roi_pct, realized_pnl, close_reason
       FROM trades
      WHERE opened_at > $1 AND status = 'CLOSED'
      ORDER BY opened_at DESC LIMIT 60`, [since]).catch(() => ({ rows: [] }));

  return {
    windowDays: WINDOW_DAYS,
    performance: trades,
    strategyTable: stats.rows,
    memories: memories.map((m) => ({ kind: m.kind, subject: m.subject, content: m.content })),
    recentTrades: recent.rows,
    signalFlow: signals.rows[0],
  };
}

/**
 * Run one dream cycle. Returns the findings text, or null if it declined to
 * produce anything (nothing to reflect on, or the model said there was nothing
 * new — which is a valid and common answer, not a failure).
 */
export async function dream(chatId = 'dream') {
  const data = await gather(chatId);
  if (!data) return { ok: false, reason: 'could not read history' };

  const p = data.performance;
  if (!p.trades && !data.recentTrades.length) {
    return { ok: true, empty: true, findings: null, reason: 'no closed trades in the window' };
  }

  const prompt = `You are reviewing your OWN trading history from the last ${WINDOW_DAYS} days. This is a reflection pass, not a trading pass.

PERFORMANCE
  trades ${p.trades} · wins ${p.wins} · losses ${p.losses} · realised PnL ${Number(p.pnl || 0).toFixed(2)} USDT

PER-STRATEGY RECORD (this is what reweights the consensus)
${data.strategyTable.map((r) => `  ${r.strategy.padEnd(20)} ${r.wins}W/${r.losses}L  pnl ${Number(r.pnl).toFixed(2)}  weight ${Number(r.weight).toFixed(2)}`).join('\n') || '  (none)'}

SIGNAL FLOW
  ${data.signalFlow?.n || 0} signals produced, ${data.signalFlow?.taken || 0} taken, avg confidence ${data.signalFlow?.avg_conf || 0}, avg agreement ${data.signalFlow?.avg_agree || 0}

RECENT CLOSED TRADES
${data.recentTrades.slice(0, 25).map((t) => `  ${t.symbol} ${t.side} roi ${t.roi_pct ?? '?'}% conf ${t.confidence} agree ${t.agreement} · ${t.close_reason || ''}`).join('\n') || '  (none)'}

WHAT YOU BELIEVE RIGHT NOW
${data.memories.slice(0, 25).map((m) => `  - [${m.kind}${m.subject ? '/' + m.subject : ''}] ${m.content}`).join('\n')}

Think about the PATTERN, not the individual trades. Look for: which of your strategies are actually earning and which are decoration; whether your confidence gate is well calibrated (are you taking signals that lose more than you keep?); what your losing trades have in common that your winning ones do not; anything you have been asserting in memory that your own results contradict.

Then reply with ONLY a JSON object:
{"findings": [{"content": "one specific, falsifiable lesson", "importance": 1-10, "subject": "SYMBOL or topic or null"}], "summary": "one paragraph on your current edge and what you would change"}

Be honest and specific. If there is genuinely nothing new to learn, return {"findings": [], "summary": "..."}. Do not invent lessons to seem productive. A lesson that would not change any decision is worthless — omit it.`;

  let text;
  try {
    const r = await ai.chat({
      messages: [
        { role: 'system', content: 'You are reviewing your own trading results. Reply with JSON only.' },
        { role: 'user', content: prompt },
      ],
      thinking: 'high', maxTokens: 2000, temperature: 0.3,
    });
    text = r.content;
  } catch (e) {
    log.warn(`dream: model unavailable (${e.message})`);
    return { ok: false, reason: e.message };
  }

  const m = String(text || '').match(/\{[\s\S]*\}/);
  let parsed = null;
  if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fall through */ } }
  if (!parsed) {
    log.warn('dream: no JSON from the model — nothing written');
    return { ok: false, reason: 'model returned no usable JSON' };
  }

  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const kept = [];          // only the ones that actually reached memory
  for (const f of findings) {
    const content = String(f.content || '').trim();
    if (!content) continue;
    // A finding that is already in memory is not a new lesson; skip it rather
    // than growing the table with near-duplicates every night. The query
    // decides this, not the model — but if the query itself fails we must NOT
    // guess "not a duplicate" and write it, because a dream pass that runs
    // nightly would then duplicate its own output until the table fills up.
    let isDupe = false;
    try {
      const dup = await db.pool.query(
        `SELECT 1 FROM memories
          WHERE content = $1 AND created_at > now() - interval '30 days' LIMIT 1`, [content]);
      isDupe = Boolean(dup.rowCount);
    } catch (e) {
      log.warn(`dupe check failed (${e.message}) — writing anyway, memory dedupe is best-effort`);
    }
    if (isDupe) continue;

    await db.remember({
      kind: 'lesson', subject: f.subject || null, content,
      importance: Math.max(1, Math.min(10, Number(f.importance) || 7)),
    });
    kept.push({ content, subject: f.subject || null });
  }
  const written = kept.length;
  const skipped = findings.length - written;

  await db.logEvent('dream', {
    findings: findings.length, written, skipped,
    summary: String(parsed.summary || '').slice(0, 2000),
  }).catch(() => {});
  log.info(`dream: ${written} new lesson(s) from ${findings.length} finding(s)${skipped ? `, ${skipped} already known` : ''}`);

  return { ok: true, findings: kept, written, skipped, summary: parsed.summary || '', performance: p };
}

/** Render a dream cycle for Telegram. */
export function formatDream(result) {
  if (!result?.ok) return `💤 *Dream* did not run: ${result?.reason || 'unknown reason'}`;
  if (result.empty) return `💤 *Dream* — ${result.reason}. Nothing to reflect on yet.`;
  const lines = [bold('💤 Dream — what I learned from my own trading'), ''];
  lines.push(italic(result.summary || ''));
  if (result.written) {
    lines.push('', bold(`${result.written} new lesson(s) written to long-term memory:`));
    for (const f of result.findings.slice(0, 8)) {
      lines.push(`• ${f.content}`);
    }
  } else {
    lines.push('', italic('No new lessons — everything I found, I already knew.'));
  }
  return lines.join('\n');
}

export default dream;
