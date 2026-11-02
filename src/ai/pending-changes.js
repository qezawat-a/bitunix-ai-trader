/**
 * Risk and signal-gate settings are the user's decision. In a chat turn the AI
 * may PROPOSE a change to one of them (it is how min_confidence 80 -> 50 and
 * min_agreement 2 -> 1 slipped in while the user was just asking why signals
 * were not being taken), but the change only lands when the user confirms it
 * with /confirmset from the allow-listed Telegram chat. Nothing here is a tool
 * the model can call to apply a pending change.
 */
export const PROTECTED_KEYS = new Set([
  'margin_pct', 'leverage', 'margin_mode', 'position_mode', 'order_unit', 'max_open_positions',
  'min_agreement', 'min_confidence', 'tf_min_confidence', 'signal_confirm_scans', 'cooldown_min',
  'reversal_enabled', 'reversal_confidence',
  'breakeven_threshold', 'trailing_trigger_roi_pct', 'trailing_distance_atr', 'trailing_method',
  'liq_distance', 'min_stop_pct', 'tp_mode', 'tpsl_method', 'partial_tp_ladder',
  'universe_rank', 'universe_size', 'min_24h_volume_usd', 'symbols', 'timeframes', 'auto_trade',
]);

const TTL_MS = 30 * 60 * 1000;
const pending = new Map();   // id -> { id, tool, args, summary, at }
let nextId = 1;

const isOff = (v) => v === false || /^(off|false|0|no)$/i.test(String(v));

/** Turning auto_trade OFF is always allowed: it is the safe direction. */
export function needsConfirmation(key, value) {
  if (!PROTECTED_KEYS.has(key)) return false;
  if (key === 'auto_trade' && isOff(value)) return false;
  return true;
}

export function queueChange({ tool, args, summary }) {
  const id = nextId++;
  pending.set(id, { id, tool, args, summary, at: Date.now() });
  return id;
}

function sweep() { for (const [id, p] of pending) if (Date.now() - p.at > TTL_MS) pending.delete(id); }

export function listPending() { sweep(); return [...pending.values()]; }
export function takePending(id) { sweep(); const p = pending.get(Number(id)); if (p) pending.delete(Number(id)); return p || null; }
export function dropPending(id) { return pending.delete(Number(id)); }
