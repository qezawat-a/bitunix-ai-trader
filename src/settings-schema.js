/**
 * One validator for every runtime setting.
 *
 * Both entry points use it — /set from Telegram and update_settings from the
 * agent — so a bad value cannot reach the database from either direction.
 * Before this existed, /set validated and the agent's tool did not, which meant
 * the LLM could set `timeframes: "3min"` and kill the scanner on the next tick.
 */
import { SUPPORTED_TIMEFRAMES, timeframeMinutes, normaliseTimeframe } from './scanner/scanner.js';

export const NUMERIC = new Set([
  'trailing_callback', 'account_tp_usdt', 'account_sl_usdt', 'min_account_balance_usdt', 'heartbeat_minutes',
  'leverage', 'margin_pct', 'universe_size', 'min_24h_volume_usd',
  'scan_interval_sec', 'manage_interval_sec', 'guard_interval_sec',
  'report_interval_sec', 'agent_autonomous_sec', 'min_agreement',
  'min_confidence', 'tf_min_confidence', 'signal_confirm_scans', 'cooldown_min',
  'reversal_confidence', 'breakeven_threshold', 'trailing_trigger_roi_pct',
  'trailing_distance_atr', 'max_open_positions',
]);

export const BOOLEAN = new Set([
  'auto_trade', 'reversal_enabled', 'autocompact', 'auto_refresh_model',
]);

/** Inclusive bounds for the numeric keys that have a sane range. */
const RANGES = {
  trailing_callback: [0.05, 50],
  account_tp_usdt: [0, 1e9],
  account_sl_usdt: [0, 1e9],
  min_account_balance_usdt: [0, 1e9],
  heartbeat_minutes: [5, 1440],
  leverage: [1, 125],
  margin_pct: [0.1, 100],
  universe_size: [1, 200],
  min_24h_volume_usd: [0, 1e12],
  scan_interval_sec: [5, 3600],
  manage_interval_sec: [5, 3600],
  guard_interval_sec: [5, 3600],
  report_interval_sec: [10, 86400],
  agent_autonomous_sec: [5, 86400],
  min_agreement: [1, 6],
  min_confidence: [0, 100],
  tf_min_confidence: [0, 100],
  signal_confirm_scans: [1, 10],
  cooldown_min: [0, 1440],
  reversal_confidence: [0, 100],
  breakeven_threshold: [0, 1000],
  trailing_trigger_roi_pct: [0, 1000],
  trailing_distance_atr: [0.1, 5],
  max_open_positions: [1, 50],
};

const ENUMS = {
  margin_mode: ['CROSS', 'ISOLATION'],
  position_mode: ['HEDGE', 'ONE_WAY'],
  order_unit: ['NOMINAL', 'COST', 'QTY'],
  tpsl_method: ['POSITION', 'PARTIAL'],
  trailing_method: ['ATR', 'RATIO', 'INTERVAL'],
  thinking_level: ['off', 'low', 'medium', 'high'],
};

/**
 * Validate and normalise one setting.
 * @throws {Error} with a message meant to be shown to the user or the model
 * @returns the coerced value, ready to persist
 */
/**
 * Parse a partial-take-profit ladder: "share@R, share@R, ...".
 *
 *   "40@1,35@2,25@3"  ->  40% of the position at 1R, 35% at 2R, 25% at 3R
 *
 * Lives here rather than next to the order code so that /set, the
 * update_settings tool and the executor all validate it identically — a
 * ladder that /set accepts can never throw at order time.
 */
export function parseLadder(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return [];
  const steps = [];
  for (const part of raw.split(',')) {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*@\s*(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`bad ladder step "${part.trim()}" — expected "share@R", e.g. "30@1.5"`);
    const share = Number(m[1]);
    const r = Number(m[2]);
    if (!(share > 0) || share > 100) throw new Error(`ladder share must be 0-100, got ${share}`);
    if (!(r > 0)) throw new Error(`ladder R multiple must be > 0, got ${r}`);
    steps.push({ share, r });
  }
  const total = steps.reduce((a, b) => a + b.share, 0);
  if (total > 100.0001) throw new Error(`ladder shares sum to ${total}%, must be <= 100`);
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].r <= steps[i - 1].r) {
      throw new Error(`ladder targets must increase: ${steps[i - 1].r}R then ${steps[i].r}R`);
    }
  }
  return steps;
}

export function validateSetting(key, raw) {
  if (NUMERIC.has(key)) {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
    const r = RANGES[key];
    if (r && (n < r[0] || n > r[1])) throw new Error(`${key} must be between ${r[0]} and ${r[1]}, got ${n}`);
    return n;
  }

  if (BOOLEAN.has(key)) {
    if (typeof raw === 'boolean') return raw;
    const v = String(raw).trim().toLowerCase();
    if (['true', 'on', 'yes', '1'].includes(v)) return true;
    if (['false', 'off', 'no', '0'].includes(v)) return false;
    throw new Error(`${key} must be true or false, got "${raw}"`);
  }

  const v = String(raw).trim();

  if (key === 'partial_tp_ladder') {
    const steps = parseLadder(raw);
    if (!steps.length) throw new Error('ladder needs at least one step, e.g. 40@1,35@2,25@3');
    return steps.map((x) => `${x.share}@${x.r}`).join(',');
  }

  if (key === 'timeframes') {
    const tfs = v.split(',').map((x) => x.trim()).filter(Boolean);
    if (!tfs.length) throw new Error('timeframes needs at least one interval, e.g. 3m,15m,1h');
    const norm = tfs.map(normaliseTimeframe);
    const bad = norm.filter((t) => !SUPPORTED_TIMEFRAMES.includes(t));
    if (bad.length) {
      throw new Error(`unknown timeframe: ${bad.join(', ')}. Valid: ${SUPPORTED_TIMEFRAMES.join(' ')}`);
    }
    const uniq = [...new Set(norm)].sort((a, b) => timeframeMinutes(a) - timeframeMinutes(b));
    if (uniq.length > 5) throw new Error(`${uniq.length} timeframes is too many — each one is a round trip per symbol. Use at most 5.`);
    return uniq.join(',');
  }

  if (key === 'symbols') {
    const u = v.toUpperCase().replace(/\s+/g, '');
    if (!u) throw new Error('symbols must be AUTO or a comma-separated list');
    return u;
  }

  if (ENUMS[key]) {
    let u = v.toUpperCase();
    if (key === 'margin_mode' && u === 'ISOLATED') u = 'ISOLATION';
    if (key === 'thinking_level') u = v.toLowerCase();
    const allowed = ENUMS[key];
    if (!allowed.includes(u)) throw new Error(`${key} must be one of: ${allowed.join(', ')} — got "${raw}"`);
    return u;
  }

  return v;
}
