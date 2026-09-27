import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (e) => log.warn('pool error:', e.message));

export const q = (text, params) => pool.query(text, params);

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
