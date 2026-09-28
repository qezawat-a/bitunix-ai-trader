import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('ai');

/**
 * Multi-provider LLM layer with:
 *  - AUTO provider selection (any key present is usable)
 *  - autoSetModelByKey(): ranks the models your key can see, then PROBES them
 *    with a real tiny tool-calling request and keeps the first that actually
 *    works. Listing a model does not mean your key may call it.
 *  - a blacklist so a model that fails at runtime is never picked again
 *  - automatic failover between providers
 *  - a single unified tool-calling interface
 */

const MODEL_PREFERENCE = [
  // strongest reasoning first; matched as substrings against the model list
  'o4', 'o3', 'gpt-5', 'gpt-4.1', 'gpt-4o',
  'claude-sonnet-4', 'claude-3-7-sonnet', 'claude-3-5-sonnet',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash',
  'deepseek-reasoner', 'deepseek-chat', 'qwen3', 'qwen2.5-72b',
  'llama-3.3-70b', 'grok-4', 'grok-3', 'kimi-k2', 'mistral-large',
];

/**
 * Models that exist in /models but cannot serve a chat completion with tools.
 * Picking one of these is the classic "AUTO chose a model I can't use" failure.
 */
const NON_CHAT = [
  'embed', 'embedding', 'moderation', 'whisper', 'tts', 'audio', 'speech',
  'dall-e', 'image', 'vision-only', 'rerank', 'clip', 'search-', 'similarity',
  'davinci', 'babbage', 'curie', 'ada', 'instruct', 'edit', 'codex',
  'realtime', 'transcribe', 'guard', 'safety', 'veo', 'imagen', 'aqa',
];

/** Cheap/limited variants we only fall back to, never prefer. */
const DEPRIORITISE = ['nano', 'mini', 'lite', 'tiny', 'small', '8b', '7b', '3b', '1b', 'preview', 'exp', 'beta'];

function isChatModel(id) {
  const l = id.toLowerCase();
  return !NON_CHAT.some((x) => l.includes(x));
}

/** Hints that an unknown model (common on relays) is a capable flagship. */
const CAPABLE_HINT = [
  'sonnet', 'opus', 'pro', 'max', 'plus', 'large', 'flagship', 'turbo',
  'reasoner', 'thinking', 'r1', '235b', '405b', '120b', '70b', '72b', '32b',
];

function rankModel(id) {
  const lower = id.toLowerCase();
  let rank = null;
  for (let i = 0; i < MODEL_PREFERENCE.length; i++) {
    if (lower.includes(MODEL_PREFERENCE[i])) { rank = i; break; }
  }

  if (rank === null) {
    // Unknown id — typical on a relay where the operator renames everything.
    // Rank it just after the known families, ordered by capability hints so we
    // try "qwen3-235b" before "some-tiny-model", rather than alphabetically.
    const hints = CAPABLE_HINT.reduce((a, x) => a + (lower.includes(x) ? 1 : 0), 0);
    rank = MODEL_PREFERENCE.length + Math.max(0, 4 - hints);
  }

  const penalty = DEPRIORITISE.reduce((a, x) => a + (lower.includes(x) ? 1 : 0), 0);
  return rank * 10 + penalty;
}

function thinkingBudget(level) {
  return { off: 0, low: 1024, medium: 4096, high: 12288 }[String(level).toLowerCase()] ?? 4096;
}

/** A tiny tool schema used to verify the model can actually do tool calling. */
const PROBE_TOOL = [{
  name: 'ping',
  description: 'Reply to a readiness check.',
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
}];

// ------------------------------------------------------------------ base

class Provider {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.model = null;
    this.failures = 0;
    this.blacklist = new Set();     // models proven unusable with this key
    this.toolSupport = new Map();   // model -> does it do tool calling
    this.throttledUntil = new Map(); // model -> ts, rate-limited (not blacklisted)
    this.candidates = null;         // ranked, filtered model ids
    this.probing = null;
  }

  get enabled() { return Boolean(this.cfg.key); }

  /** Explicit model in .env wins — no probing, no second-guessing. */
  get pinned() {
    const m = this.cfg.model;
    return m && m.toUpperCase() !== 'AUTO' ? m : null;
  }

  async ready() {
    if (this.model) return this.model;
    if (!this.probing) this.probing = this.autoSetModelByKey().finally(() => { this.probing = null; });
    this.model = await this.probing;
    return this.model;
  }

  /**
   * Rank the visible models, then probe them in order with a real request.
   * The first model that answers a tool-calling round trip is selected.
   */
  async autoSetModelByKey() {
    if (this.pinned) { log.info(`[${this.name}] model pinned -> ${this.pinned}`); return this.pinned; }

    // The model list is the ONLY source of candidate names. We never invent an
    // id: on a relay/gateway (one-api, new-api, LiteLLM, OpenRouter) the models
    // are named whatever the operator called them, and guessing "gpt-4o-mini"
    // produces "available channels for model gpt-4o-mini in group default".
    let ids;
    try {
      ids = await this.listModels();
    } catch (e) {
      throw new Error(
        `[${this.name}] cannot list models (${short(e.message)}). `
        + `Set an explicit model in .env (e.g. ${this.envVar}=<model-id>) — `
        + `this endpoint does not expose /models.`,
      );
    }

    const now = Date.now();
    for (const [id, until] of this.throttledUntil) if (until <= now) this.throttledUntil.delete(id);

    const chat = ids.filter(isChatModel);
    const notRejected = chat.filter((id) => !this.blacklist.has(id));
    const fresh = notRejected.filter((id) => !this.throttledUntil.has(id))
      .sort((a, b) => rankModel(a) - rankModel(b));

    // Rate-limited models get a 15-minute cooldown, not a blacklist entry. But
    // if EVERY model is cooling off, "no usable model" is the wrong story — the
    // truth is "we are temporarily out of quota", and refusing to run is worse
    // than trying the one whose 15 minutes is closest to up. Only a key that
    // has genuinely rejected every model it can see is a hard failure.
    let ranked = fresh;
    let throttledFallback = false;
    if (!ranked.length && notRejected.length) {
      ranked = notRejected.sort((a, b) => rankModel(a) - rankModel(b));
      throttledFallback = true;
    }

    if (!ranked.length) {
      throw new Error(
        `[${this.name}] none of the ${ids.length} listed models are usable`
        + (this.blacklist.size ? ` (rejected: ${[...this.blacklist].join(', ')})` : '')
        + `. Visible: ${chat.slice(0, 15).join(', ') || '(none)'}`,
      );
    }

    this.candidates = ranked;
    if (throttledFallback) {
      log.warn(`[${this.name}] every model is rate-limited; trying them anyway rather than refusing to run`);
    }
    log.info(`[${this.name}] ${ids.length} models visible, ${ranked.length} chat-capable; probing…`);

    // Probe every candidate, best first. A relay may list dozens of models of
    // which only a couple are actually wired to a channel, so we do not give up
    // after the first few — but we cap the wall-clock cost.
    const budgetMs = 90_000;
    const startedAt = Date.now();
    let probed = 0;

    for (const id of ranked) {
      if (Date.now() - startedAt > budgetMs) {
        log.warn(`[${this.name}] probe budget exhausted after ${probed} models`);
        break;
      }
      probed++;
      const verdict = await this.probe(id);
      if (verdict.ok) {
        log.info(`[${this.name}] autoSetModelByKey -> ${id} ✅ (tools: ${verdict.tools ? 'yes' : 'no'}, probed ${probed})`);
        return id;
      }
      this.blacklist.add(id);
      log.warn(`[${this.name}] ✗ ${id}: ${verdict.reason}`);
    }

    throw new Error(
      `[${this.name}] probed ${probed} model(s), none responded. `
      + `Rejected: ${[...this.blacklist].slice(0, 8).join(', ')}. `
      + `Pin a working one with ${this.envVar}=<model-id> or /models set ${this.name} <model-id>.`,
    );
  }

  /**
   * Send a minimal REAL request to confirm this key may call this model.
   * Two stages: with tools (what the agent needs), then without (still useful
   * for summaries/autocompact). A relay that has no channel wired for the model
   * fails both and the model is rejected outright.
   */
  async probe(model) {
    const ask = (tools) => this.chat({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: READY' }],
      ...(tools ? { tools: PROBE_TOOL } : {}),
      thinking: 'off',
      maxTokens: 64,
      timeout: 25_000,
    });

    try {
      const r = await ask(true);
      if (r.content?.trim() || r.toolCalls?.length) {
        this.toolSupport.set(model, true);
        return { ok: true, tools: true };
      }
      return { ok: false, reason: 'empty response' };
    } catch (e) {
      // A missing channel / no access is fatal for this model — do not retry it.
      if (isModelFault(e.message)) return { ok: false, reason: short(e.message) };

      // Otherwise it may simply not support tool calling. Retry plain.
      try {
        const r = await ask(false);
        if (r.content?.trim()) {
          this.toolSupport.set(model, false);
          log.warn(`[${this.name}] ${model} works but has NO tool calling — usable only as a fallback`);
          return { ok: true, tools: false };
        }
        return { ok: false, reason: 'empty response (no tools)' };
      } catch (e2) {
        return { ok: false, reason: short(e2.message) };
      }
    }
  }

  /** Mark the current model bad and immediately resolve the next candidate. */
  async demote(reason, { permanent = true } = {}) {
    if (!this.model || this.pinned) return null;
    log.warn(`[${this.name}] demoting ${this.model}: ${short(reason)}`);
    // A throttled model is only skipped for THIS session, not blacklisted for
    // good — blacklisting it would make /models report a working model as
    // rejected and would shrink the candidate pool every time a quota is hit.
    if (permanent) this.blacklist.add(this.model);
    else this.throttledUntil.set(this.model, Date.now() + 15 * 60_000);
    this.model = null;
    try {
      return await this.ready();
    } catch (e) {
      log.error(`[${this.name}] no usable model left — ${short(e.message)}`);
      return null;
    }
  }
}

const short = (m) => String(m).replace(/\s+/g, ' ').slice(0, 140);

/**
 * Errors that mean "this model is throttled right now" — as opposed to being
 * unusable, or a network blip.
 *
 * The distinction drives a deliberate decision: on a 429 the request is
 * retried on a DIFFERENT MODEL of the same provider, not handed to a weaker
 * provider. Rate limits are per-model on every provider that has them, so
 * switching model is what actually recovers; failing over to another provider
 * silently downgrades the agent's brain on the single most common runtime
 * error, which is the opposite of what the model router is for.
 */
function isRateLimited(msg) {
  return /rate[_ -]?limit|too many requests|429|quota|overloaded|503|resource[_ ]exhausted|capacity|try again later|server_error/i.test(String(msg));
}

/** Errors that mean "this model is not usable with this key" (not a transient fault). */
function isModelFault(msg) {
  const m = String(msg);
  return (
    // OpenAI / Anthropic / Gemini wording
    /model[_ ]?not[_ ]?found|does not exist|do not have access|not allowed|unsupported[_ ]?model|invalid[_ ]?model|no such model|permission|unauthorized|not authorized|must be verified|deprecat|decommission/i.test(m)
    // relay / gateway wording (one-api, new-api, oneapi forks, LiteLLM, openrouter)
    || /available channels|no available channel|channel.*not found|no permission to use model|model.*not.*enabled|group.*not.*support|无可用渠道|无权使用/i.test(m)
    || /\b(404|400)\b/.test(m)
  );
}

// -------------------------------------------------------- OpenAI compatible

class OpenAICompatible extends Provider {
  get envVar() { return 'OPENAI_COMPATIBLE_MODEL'; }

  async listModels() {
    const res = await fetch(`${this.cfg.url}/models`, {
      headers: { Authorization: `Bearer ${this.cfg.key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ids = (json.data || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) throw new Error('empty model list');
    return ids;
  }

  async chat({ messages, tools, temperature = 0.2, thinking = 'high', maxTokens = 2048, model: override, timeout = 120_000 }) {
    const model = override || await this.ready();
    const body = { model, messages, temperature, max_tokens: maxTokens };
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    // reasoning models use a different token field and reject temperature
    if (/^(o\d|gpt-5)/i.test(model)) {
      body.reasoning_effort = thinking === 'off' ? 'low' : thinking;
      delete body.temperature;
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }

    const res = await fetch(`${this.cfg.url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const m = json.choices?.[0]?.message;
    return {
      provider: this.name, model,
      content: m?.content || '',
      toolCalls: (m?.tool_calls || []).map((c) => ({
        id: c.id, name: c.function.name, args: safeJson(c.function.arguments),
      })),
      raw: m,
    };
  }
}

// ------------------------------------------------------------------ Gemini

class Gemini extends Provider {
  get envVar() { return 'GEMINI_GOOGLE_MODEL'; }

  async listModels() {
    const res = await fetch(`${this.cfg.url}/models?key=${this.cfg.key}&pageSize=200`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ids = (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    if (!ids.length) throw new Error('empty model list');
    return ids;
  }

  async chat({ messages, tools, temperature = 0.2, thinking = 'high', maxTokens = 2048, model: override, timeout = 120_000 }) {
    const model = override || await this.ready();
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = [];
    // Same batching as Anthropic above: parallel tool calls arrive as several
    // consecutive tool messages and must become one user turn carrying every
    // functionResponse, or the model loses the pairing.
    let pendingResponses = [];
    const flushResponses = () => {
      if (!pendingResponses.length) return;
      contents.push({ role: 'user', parts: pendingResponses });
      pendingResponses = [];
    };
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        pendingResponses.push({ functionResponse: { name: m.name, response: { result: m.content } } });
        continue;
      }
      flushResponses();
      if (m.role === 'assistant' && m.tool_calls?.length) {
        contents.push({ role: 'model', parts: m.tool_calls.map((c) => ({ functionCall: { name: c.function.name, args: safeJson(c.function.arguments) } })) });
      } else {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content || '' }] });
      }
    }
    flushResponses();
    const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (/2\.5|thinking/i.test(model) && thinking !== 'off') {
      body.generationConfig.thinkingConfig = { thinkingBudget: thinkingBudget(thinking) };
    }
    if (tools?.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })) }];
    }

    const res = await fetch(`${this.cfg.url}/models/${model}:generateContent?key=${this.cfg.key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const parts = json.candidates?.[0]?.content?.parts || [];
    return {
      provider: this.name, model,
      content: parts.filter((p) => p.text).map((p) => p.text).join(''),
      toolCalls: parts.filter((p) => p.functionCall)
        .map((p, i) => ({ id: `g${i}`, name: p.functionCall.name, args: p.functionCall.args || {} })),
      raw: json,
    };
  }
}

// --------------------------------------------------------------- Anthropic

class Anthropic extends Provider {
  get envVar() { return 'ANTHROPIC_MODEL'; }

  async listModels() {
    const res = await fetch(`${this.cfg.url}/models?limit=100`, {
      headers: { 'x-api-key': this.cfg.key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ids = (json.data || []).map((m) => m.id);
    if (!ids.length) throw new Error('empty model list');
    return ids;
  }

  async chat({ messages, tools, temperature = 0.2, thinking = 'high', maxTokens = 2048, model: override, timeout = 120_000 }) {
    const model = override || await this.ready();
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const conv = [];
    // Batch CONSECUTIVE tool results into ONE user message.
    //
    // The agent loop runs every tool call the model asked for and emits one
    // message per result. When the model requests two tools in parallel that
    // became two user messages in a row, and the Messages API rejects that
    // with 400 "roles must alternate between user and assistant" — so any turn
    // where the agent called two tools in parallel died on a real model and
    // worked on a mock. All of an assistant turn's tool_use blocks must be
    // answered inside the single user message that follows it.
    let pendingToolResults = [];
    const flushToolResults = () => {
      if (!pendingToolResults.length) return;
      conv.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    };

    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        pendingToolResults.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content).slice(0, 8000) });
        continue;
      }
      flushToolResults();
      if (m.role === 'assistant' && m.tool_calls?.length) {
        conv.push({ role: 'assistant', content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.tool_calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.function.name, input: safeJson(c.function.arguments) })),
        ] });
      } else {
        conv.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '(empty)' });
      }
    }
    const body = { model, system, messages: conv, max_tokens: maxTokens, temperature };
    if (thinking !== 'off' && /sonnet-4|opus-4|3-7/i.test(model)) {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget(thinking) };
      body.max_tokens = Math.max(maxTokens, thinkingBudget(thinking) + 1024);
      delete body.temperature;
    }
    if (tools?.length) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const res = await fetch(`${this.cfg.url}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': this.cfg.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    return {
      provider: this.name, model,
      content: (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
      toolCalls: (json.content || []).filter((c) => c.type === 'tool_use')
        .map((c) => ({ id: c.id, name: c.name, args: c.input || {} })),
      raw: json,
    };
  }
}

// ------------------------------------------------------------------ router

function safeJson(x) {
  if (!x) return {};
  if (typeof x === 'object') return x;
  try { return JSON.parse(x); } catch { return {}; }
}

/** Gemini rejects some JSON-schema keywords. */
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = Array.isArray(schema) ? [] : {};
  for (const [k, v] of Object.entries(schema)) {
    if (['additionalProperties', '$schema', 'default', 'examples'].includes(k)) continue;
    out[k] = typeof v === 'object' && v !== null ? sanitizeSchema(v) : v;
  }
  return out;
}

export class AIRouter {
  constructor() {
    this.providers = [
      new OpenAICompatible('openai', config.ai.openai),
      new Gemini('gemini', config.ai.gemini),
      new Anthropic('anthropic', config.ai.anthropic),
    ].filter((p) => p.enabled);

    const pref = config.ai.provider;
    if (pref && pref !== 'AUTO') {
      const name = pref.toLowerCase().includes('gemini') ? 'gemini'
        : pref.toLowerCase().includes('anthropic') ? 'anthropic' : 'openai';
      this.providers.sort((a, b) => (a.name === name ? -1 : b.name === name ? 1 : 0));
    }
    this.active = this.providers[0] || null;
  }

  get available() { return this.providers.length > 0; }

  status() {
    return this.providers.map((p) => ({
      provider: p.name,
      model: p.model || (p.pinned ? `${p.pinned} (pinned)` : '(not resolved yet)'),
      pinned: Boolean(p.pinned),
      failures: p.failures,
      rejected: [...p.blacklist],
      throttled: [...p.throttledUntil.entries()]
        .filter(([, until]) => until > Date.now()).map(([id]) => id),
      tools: p.model ? p.toolSupport.get(p.model) !== false : null,
      active: p === this.active,
    }));
  }

  /** Force a full re-probe on every provider (auto refresh model). */
  async refreshModels({ clearBlacklist = false } = {}) {
    for (const p of this.providers) {
      if (clearBlacklist) { p.blacklist.clear(); p.toolSupport.clear(); p.throttledUntil.clear(); }
      p.model = null;
      p.failures = 0;
      try { await p.ready(); } catch (e) { log.warn(`[${p.name}] ${e.message}`); }
    }
    return this.status();
  }

  /** Manually pin a model at runtime (e.g. from Telegram). */
  async setModel(providerName, modelId) {
    const p = this.providers.find((x) => x.name === providerName);
    if (!p) throw new Error(`unknown provider "${providerName}" (have: ${this.providers.map((x) => x.name).join(', ')})`);
    if (String(modelId).toUpperCase() === 'AUTO') {
      p.cfg.model = 'AUTO';
      p.blacklist.clear();
      p.throttledUntil.clear();
      p.model = null;
      await p.ready();
    } else {
      const verdict = await p.probe(modelId);
      if (!verdict.ok) throw new Error(`${providerName}/${modelId} is not usable: ${verdict.reason}`);
      p.cfg.model = modelId;
      p.model = modelId;
      p.blacklist.delete(modelId);
    }
    this.active = p;
    return this.status();
  }

  /** List what each provider's key can actually see (ranked, filtered). */
  async listAvailable(providerName = null) {
    const out = {};
    for (const p of this.providers) {
      if (providerName && p.name !== providerName) continue;
      try {
        const ids = await p.listModels();
        out[p.name] = ids.filter(isChatModel).sort((a, b) => rankModel(a) - rankModel(b));
      } catch (e) { out[p.name] = { error: e.message }; }
    }
    return out;
  }

  async chat(opts) {
    if (!this.providers.length) throw new Error('No AI provider configured');
    let lastErr = null;
    const ordered = [this.active, ...this.providers.filter((p) => p !== this.active)].filter(Boolean);

    for (const p of ordered) {
      // two attempts per provider: the second one runs after demoting a bad model
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await p.chat(opts);
          p.failures = 0;
          this.active = p;
          return r;
        } catch (e) {
          lastErr = e;
          p.failures++;
          const badModel = isModelFault(e.message);
          const throttled = isRateLimited(e.message);
          log.warn(`[${p.name}/${p.model}] ${short(e.message)}${badModel ? ' — model rejected' : throttled ? ' — throttled, switching model' : ''}`);

          // Rate limit counts as a reason to switch MODEL even though the model
          // is perfectly usable — the quota belongs to this model id, not to
          // the key, so the next candidate is the correct recovery.
          if ((badModel || throttled) && !p.pinned && attempt === 0) {
            const next = await p.demote(e.message, { permanent: badModel });
            if (next) { log.info(`[${p.name}] retrying with ${next}`); continue; }
          }
          // transient fault or nothing left to try on this provider
          if (config.ai.autoRefreshModel && p.failures >= 3 && !p.pinned) {
            p.model = null; p.failures = 0;
          }
          break;
        }
      }
    }
    throw new Error(`All AI providers failed: ${short(lastErr?.message)}`);
  }
}

export const ai = new AIRouter();
export default ai;
