import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  explainDbError, isRetryable, parseTarget, probeSsl, redactUrl,
  sslCorrection, sslLabel, sslPolicy, stripSslParams, validateUrl,
} from './connection.js';

const log = createLogger('db');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const int = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const CONNECT_ATTEMPTS = int(process.env.DB_CONNECT_ATTEMPTS, 10);
const CONNECT_TIMEOUT_MS = int(process.env.DB_CONNECT_TIMEOUT_MS, 15_000);
const POOL_MAX = int(process.env.DB_POOL_MAX, 5);

const dbUrl = config.db.url;
const dbSource = config.db.source;

/**
 * TLS is a property of the *server*, not of our preference, so it is not
 * frozen at import time: we start from the best guess and let the handshake
 * correct us (see `connect`). Private Railway Postgres and public Neon then
 * both work from the same code with no flags — including the very common case
 * of a `?sslmode=require` copied off a Neon example onto an internal host.
 *
 * The exception is `verify-ca`/`verify-full`: downgrading a stated security
 * requirement because the server asked nicely is how you get MITM'd, so that
 * one is pinned and a mismatch is left to fail loudly.
 */
const policy = sslPolicy(dbUrl);
let ssl = policy.ssl;
const sslPinned = policy.pinned;

function buildPool() {
  const p = new pg.Pool({
    // sslmode stripped: the driver would otherwise let the URL overrule `ssl`
    // below, which is the decision we just took. See stripSslParams().
    connectionString: stripSslParams(dbUrl),
    ssl,
    max: POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    keepAlive: true,            // PaaS networks drop idle TCP without it
  });
  p.on('error', (e) => log.warn('pool error:', e.message));
  return p;
}

// `let` + ESM live bindings: importers keep seeing the current pool after a
// transport switch, so `import { pool }` and `db.pool.query(...)` stay valid.
export let pool = buildPool();

export const q = (text, params) => pool.query(text, params);

/** What we ended up connected to — for logs, /status and the health endpoint. */
let info = { connected: false, url: redactUrl(dbUrl), source: dbSource, ssl: sslLabel(ssl) };
export const dbInfo = () => ({ ...info });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function switchSsl(next, why) {
  if (sslLabel(ssl) === sslLabel(next)) return false;
  log.warn(`server says TLS should be ${sslLabel(next)} (${why}) — reconnecting`);
  ssl = next;
  const old = pool;
  pool = buildPool();
  try { await old.end(); } catch {}
  return true;
}

/**
 * Open the database, and keep trying.
 *
 * Two things make a deploy fail where localhost succeeds. The container boots
 * before the platform's private network resolves, so the very first connection
 * loses a race it will win a second later — hence the backoff. And the
 * transport may not be what the URL implies — hence the probe and the
 * mid-flight correction. Both are recoverable, so neither should be fatal.
 */
export async function connect({ attempts = CONNECT_ATTEMPTS, baseDelayMs = 1000 } = {}) {
  const problems = validateUrl(dbUrl, dbSource);
  if (problems.length) {
    const e = new Error(problems[0]);
    e.hints = problems.slice(1);
    e.fatal = true;
    throw e;
  }

  const target = parseTarget(dbUrl);
  log.info(`connecting to ${redactUrl(dbUrl)} (from ${dbSource}), ssl ${sslLabel(ssl)} — ${policy.reason}`);

  // Ask the server what it actually speaks instead of trusting the hostname
  // (or the URL, which is usually copied from somewhere else).
  if (!sslPinned && target) {
    const supports = await probeSsl(target.host, target.port);
    if (supports === true && ssl === false) await switchSsl({ rejectUnauthorized: false }, 'handshake probe');
    if (supports === false && ssl !== false) {
      if (policy.explicit) log.warn(`${policy.reason}, but ${target.host} does not offer TLS — overriding`);
      await switchSsl(false, 'handshake probe');
    }
  }

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const client = await pool.connect();
      try {
        const { rows } = await client.query(
          'SELECT current_database() AS db, current_user AS "user", version() AS version',
        );
        const server = String(rows[0].version).split(' ').slice(0, 2).join(' ');
        info = {
          connected: true,
          url: redactUrl(dbUrl),
          source: dbSource,
          ssl: sslLabel(ssl),
          database: rows[0].db,
          user: rows[0].user,
          server,
          host: target?.host,
        };
        log.info(`connected — ${server}, db ${rows[0].db} as ${rows[0].user}, ssl ${sslLabel(ssl)}`);
        return dbInfo();
      } finally {
        client.release();
      }
    } catch (e) {
      lastErr = e;

      // "You knocked on the wrong door" — retry immediately on the right one,
      // without spending an attempt.
      const fix = sslPinned ? null : sslCorrection(e);
      if (fix && await switchSsl(fix === 'off' ? false : { rejectUnauthorized: false }, e.message)) {
        attempt--;
        continue;
      }

      if (!isRetryable(e) || attempt === attempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 8000);
      log.warn(`connect attempt ${attempt}/${attempts} failed (${e.code || e.message}) — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  const { headline, hints } = explainDbError(lastErr, { url: dbUrl, source: dbSource, ssl });
  const err = new Error(headline);
  err.cause = lastErr;
  err.hints = hints;
  throw err;
}

/**
 * Shut the pool down, once.
 *
 * Always prefer this to `pool.end()`: a TLS switch replaces the pool, and any
 * caller that destructured `pool` at import time is holding the retired one —
 * ending that twice throws "Called end on pool more than once".
 */
export async function close() {
  const p = pool;
  if (!p || p.ended || p.ending) return;
  try { await p.end(); } catch (e) { log.warn(`pool close: ${e.message}`); }
}

export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await q(sql);
  log.info('schema ready');
}

// ------------------------------------------------------------------ settings

let settingsCache = null;

export async function loadSettings() {
  const { rows } = await q('SELECT key, value FROM agent_settings');
  const s = { ...config.defaults };
  for (const r of rows) s[r.key] = r.value;
  settingsCache = s;
  return s;
}

export function settings() {
  return settingsCache || { ...config.defaults };
}

export async function seedSettings() {
  for (const [k, v] of Object.entries(config.defaults)) {
    await q(
      `INSERT INTO agent_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [k, JSON.stringify(v)],
    );
  }
  return loadSettings();
}

/**
 * Change a setting.
 *
 * The in-memory cache is updated FIRST and unconditionally, so a setting
 * always takes effect immediately — even if Neon is unreachable. Losing the
 * database must never stop you from turning auto trading off: that is the kill
 * switch. Persistence failures are reported, not thrown.
 *
 * @returns {{settings: object, persisted: boolean, error: string|null}}
 */
export async function setSetting(key, value, by = 'user') {
  settingsCache = { ...settings(), [key]: value };

  try {
    await q(
      `INSERT INTO agent_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), by],
    );
  } catch (e) {
    log.warn(`setSetting(${key}) not persisted: ${e.message} — applied in memory only`);
    return { settings: settings(), persisted: false, error: e.message };
  }

  try {
    await loadSettings();
  } catch (e) {
    log.warn(`settings reload failed: ${e.message}`);
  }
  return { settings: settings(), persisted: true, error: null };
}

// -------------------------------------------------------------- conversation

export async function saveMessage({ chatId, role, content, toolName = null, meta = {} }) {
  const { rows } = await q(
    `INSERT INTO conversations (chat_id, role, content, tool_name, meta)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [String(chatId), role, content ?? '', toolName, JSON.stringify(meta)],
  );
  return rows[0].id;
}

export async function recentMessages(chatId, limit = 40) {
  const { rows } = await q(
    `SELECT id, role, content, tool_name, created_at FROM conversations
     WHERE chat_id = $1 ORDER BY id DESC LIMIT $2`,
    [String(chatId), limit],
  );
  return rows.reverse();
}

export async function latestSummary(chatId) {
  const { rows } = await q(
    `SELECT summary, covers_until FROM conversation_summaries
     WHERE chat_id=$1 ORDER BY id DESC LIMIT 1`, [String(chatId)],
  );
  return rows[0] || null;
}

export async function saveSummary(chatId, summary, coversUntil) {
  await q(
    `INSERT INTO conversation_summaries (chat_id, summary, covers_until) VALUES ($1,$2,$3)`,
    [String(chatId), summary, coversUntil],
  );
}

export async function countMessagesSince(chatId, sinceId = 0) {
  const { rows } = await q(
    `SELECT count(*)::int AS c FROM conversations WHERE chat_id=$1 AND id > $2`,
    [String(chatId), sinceId],
  );
  return rows[0].c;
}

// ------------------------------------------------------------------ memories

export async function remember({ kind, subject = null, content, importance = 5 }) {
  try {
  const { rows } = await q(
    `INSERT INTO memories (kind, subject, content, importance) VALUES ($1,$2,$3,$4) RETURNING id`,
    [kind, subject, content, importance],
  );
  return rows[0].id;
  } catch (e) { log.warn(`remember failed: ${e.message}`); return null; }
}

export async function recall({ subject = null, kind = null, limit = 12 } = {}) {
  try {
  const { rows } = await q(
    `SELECT id, kind, subject, content, importance, created_at FROM memories
     WHERE ($1::text IS NULL OR subject = $1)
       AND ($2::text IS NULL OR kind = $2)
     ORDER BY importance DESC, created_at DESC LIMIT $3`,
    [subject, kind, limit],
  );
  if (rows.length) {
    await q(`UPDATE memories SET hits = hits + 1, last_used = now() WHERE id = ANY($1::bigint[])`,
      [rows.map((r) => String(r.id))]);
  }
  return rows;
  } catch (e) { log.warn(`recall failed: ${e.message}`); return []; }
}

export async function searchMemories(term, limit = 10) {
  const { rows } = await q(
    `SELECT kind, subject, content, importance FROM memories
     WHERE content ILIKE '%'||$1||'%' OR subject ILIKE '%'||$1||'%'
     ORDER BY importance DESC, created_at DESC LIMIT $2`, [term, limit],
  );
  return rows;
}

// ------------------------------------------------------------------- signals

export async function saveSignal(sig) {
  try {
  const { rows } = await q(
    `INSERT INTO signals (symbol, side, confidence, agreement, strategies, timeframes,
                          price, atr, atr_pct, regime, taken, reject_reason, ai_verdict)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
    [sig.symbol, sig.side, sig.confidence, sig.agreement,
      JSON.stringify(sig.strategies || []), JSON.stringify(sig.timeframes || {}),
      sig.price ?? null, sig.atr ?? null, sig.atrPct ?? null, sig.regime ?? null,
      sig.taken ?? false, sig.rejectReason ?? null, JSON.stringify(sig.aiVerdict || null)],
  );
  return rows[0].id;
  } catch (e) { log.warn(`saveSignal failed: ${e.message}`); return null; }
}

export async function recentSignals(limit = 10) {
  const { rows } = await q(
    `SELECT symbol, side, confidence, agreement, strategies, taken, reject_reason, created_at
     FROM signals ORDER BY id DESC LIMIT $1`, [limit],
  );
  return rows;
}

/** how many times the same symbol+side appeared in the last N minutes (confirm-scans) */
export async function signalStreak(symbol, side, minutes = 5) {
  try {
  const { rows } = await q(
    `SELECT count(*)::int AS c FROM signals
     WHERE symbol=$1 AND side=$2 AND created_at > now() - ($3 || ' minutes')::interval`,
    [symbol, side, String(minutes)],
  );
  return rows[0].c;
  } catch (e) { log.warn(`signalStreak failed: ${e.message}`); return 0; }
}

// -------------------------------------------------------------------- trades

export async function openTrade(t) {
  const { rows } = await q(
    `INSERT INTO trades (position_id, client_id, symbol, side, entry_price, qty, leverage,
                         margin_mode, margin_usdt, tp_price, sl_price, atr, confidence,
                         agreement, strategies, reasoning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING id`,
    [t.positionId ?? null, t.clientId ?? null, t.symbol, t.side, t.entryPrice ?? null, t.qty ?? null,
      t.leverage ?? null, t.marginMode ?? null, t.marginUsdt ?? null, t.tpPrice ?? null,
      t.slPrice ?? null, t.atr ?? null, t.confidence ?? null, t.agreement ?? null,
      JSON.stringify(t.strategies || []), t.reasoning ?? null],
  );
  return rows[0].id;
}

export async function attachPositionId(tradeId, positionId) {
  await q(`UPDATE trades SET position_id=$2 WHERE id=$1`, [tradeId, String(positionId)]);
}

export async function closeTrade({ positionId, exitPrice, realizedPnl, roiPct, reason }) {
  const { rows } = await q(
    `UPDATE trades SET status='CLOSED', exit_price=$2, realized_pnl=$3, roi_pct=$4,
            close_reason=$5, closed_at=now()
     WHERE position_id=$1 AND status='OPEN' RETURNING *`,
    [String(positionId), exitPrice ?? null, realizedPnl ?? null, roiPct ?? null, reason ?? null],
  );
  return rows[0] || null;
}

export async function openTrades() {
  try {
    const { rows } = await q(`SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC`);
    return rows;
  } catch (e) { log.warn(`openTrades failed: ${e.message}`); return []; }
}

export async function tradeByPosition(positionId) {
  try {
    const { rows } = await q(`SELECT * FROM trades WHERE position_id=$1 ORDER BY id DESC LIMIT 1`,
      [String(positionId)]);
    return rows[0] || null;
  } catch (e) { log.warn(`tradeByPosition failed: ${e.message}`); return null; }
}

export async function tradeStats(days = 7) {
  const { rows } = await q(
    `SELECT count(*)::int AS trades,
            count(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
            count(*) FILTER (WHERE realized_pnl <= 0)::int AS losses,
            COALESCE(sum(realized_pnl),0)::numeric AS pnl
     FROM trades WHERE status='CLOSED' AND closed_at > now() - ($1||' days')::interval`,
    [String(days)],
  );
  return rows[0];
}

// --------------------------------------------------------- strategy learning

export async function bumpStrategy(strategy, won, pnl) {
  await q(
    `INSERT INTO strategy_stats (strategy, wins, losses, pnl)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (strategy) DO UPDATE SET
       wins = strategy_stats.wins + EXCLUDED.wins,
       losses = strategy_stats.losses + EXCLUDED.losses,
       pnl = strategy_stats.pnl + EXCLUDED.pnl,
       weight = GREATEST(0.4, LEAST(1.6,
         1.0 + ((strategy_stats.wins + EXCLUDED.wins)::numeric
                - (strategy_stats.losses + EXCLUDED.losses))
               / GREATEST(5, strategy_stats.wins + strategy_stats.losses + 1) * 0.5)),
       updated_at = now()`,
    [strategy, won ? 1 : 0, won ? 0 : 1, pnl || 0],
  );
}

export async function strategyWeights() {
  try {
    const { rows } = await q(`SELECT strategy, weight, wins, losses, pnl FROM strategy_stats`);
    const map = {};
    for (const r of rows) map[r.strategy] = Number(r.weight);
    return { map, rows };
  } catch (e) {
    log.warn(`strategyWeights unavailable (${e.message}) — using neutral weights`);
    return { map: {}, rows: [] };
  }
}

// ----------------------------------------------------------------- cooldowns

export async function setCooldown(symbol, minutes, reason = '') {
  try {
  await q(
    `INSERT INTO cooldowns (symbol, until, reason)
     VALUES ($1, now() + ($2||' minutes')::interval, $3)
     ON CONFLICT (symbol) DO UPDATE SET until = EXCLUDED.until, reason = EXCLUDED.reason`,
    [symbol, String(minutes), reason],
  );
  } catch (e) { log.warn(`setCooldown failed: ${e.message}`); }
}

export async function isCoolingDown(symbol) {
  try {
    const { rows } = await q(`SELECT until FROM cooldowns WHERE symbol=$1 AND until > now()`, [symbol]);
    return rows[0] ? rows[0].until : null;
  } catch (e) { log.warn(`cooldown check failed: ${e.message}`); return null; }
}

export async function activeCooldowns() {
  const { rows } = await q(`SELECT symbol, until, reason FROM cooldowns WHERE until > now() ORDER BY until`);
  return rows;
}

// -------------------------------------------------------------------- events

export async function logEvent(kind, payload = {}, symbol = null) {
  try {
    await q(`INSERT INTO agent_events (kind, symbol, payload) VALUES ($1,$2,$3::jsonb)`,
      [kind, symbol, JSON.stringify(payload)]);
  } catch (e) { log.warn(`logEvent failed: ${e.message}`); }
}

export async function recentEvents(limit = 20) {
  const { rows } = await q(
    `SELECT kind, symbol, payload, created_at FROM agent_events ORDER BY id DESC LIMIT $1`, [limit]);
  return rows;
}

/* ------------------------------------------------------------------ sessions
 *
 * A session is a bookmark, not a copy. Resuming one sets the conversation
 * window the agent reads from back to that point instead of the last N
 * messages, so "go back to where we were discussing the funding squeeze"
 * actually restores that context.
 */

/** Create a session bookmark at the current end of the conversation. */
export async function createSession({ chatId, name, note = null, coversUntil = null }) {
  if (!chatId || !name) throw new Error('createSession needs chatId and name');
  let until = coversUntil;
  if (until == null) {
    const r = await q('SELECT COALESCE(MAX(id), 0) AS id FROM conversations WHERE chat_id = $1', [chatId]);
    until = Number(r.rows[0]?.id || 0);
  }
  const cnt = await countMessagesSince(chatId, until);
  const { rows } = await q(
    `INSERT INTO sessions (chat_id, name, note, covers_until, messages)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [chatId, String(name).slice(0, 80), note, until, cnt],
  );
  return rows[0];
}

/** List a chat's sessions, most recently useful first. */
export async function listSessions(chatId, limit = 10) {
  const { rows } = await q(
    `SELECT s.*,
            (SELECT COUNT(*) FROM conversations c
              WHERE c.chat_id = s.chat_id AND c.id > s.covers_until) AS since_msgs
       FROM sessions s
      WHERE s.chat_id = $1
      ORDER BY COALESCE(s.last_resumed, s.created_at) DESC
      LIMIT $2`,
    [chatId, limit],
  );
  return rows;
}

/**
 * Mark a session as resumed. The agent's own window is restored by
 * summarising everything after covers_until into the session note, which is
 * what "resume" means in practice — see the caller in commands.js.
 */
export async function touchSession(id) {
  const { rows } = await q(
    `UPDATE sessions SET last_resumed = now() WHERE id = $1 RETURNING *`, [id],
  );
  return rows[0] || null;
}

/** Delete one session. The conversation itself is untouched. */
export async function deleteSession(id) {
  const { rowCount } = await q('DELETE FROM sessions WHERE id = $1', [id]);
  return rowCount > 0;
}

/** Every message after a session's bookmark — what would be re-injected. */
export async function sessionTail(sessionId, limit = 60) {
  const { rows: s } = await q('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  if (!s[0]) return null;
  const { rows } = await q(
    `SELECT * FROM conversations
      WHERE chat_id = $1 AND id > $2
      ORDER BY id ASC LIMIT $3`,
    [s[0].chat_id, s[0].covers_until, limit],
  );
  return { session: s[0], messages: rows };
}
