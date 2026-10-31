import { bitunix } from '../exchange/bitunix.js';
import { settings } from '../db/index.js';
import { createLogger } from '../logger.js';
import { clampStopInsideLiq } from './risk.js';
import { parseLadder } from '../settings-schema.js';

export { parseLadder };

const log = createLogger('tpsl');

/**
 * The four take-profit / stop-loss methods Bitunix documents in
 * "Bitunix Futures Position: A Guide to Four Take-Profit and Stop-Loss
 * Methods" (help centre id=290):
 *
 *   1. Position TP/SL   — one trigger closes the WHOLE position.
 *   2. Partial  TP/SL   — several triggers, each closing a share of it.
 *   3. Trailing TP/SL   — arms at an activation price, then closes once price
 *                         retraces by a callback amount from the best price.
 *   4. Account  TP/SL   — closes EVERY position once total PnL crosses a
 *                         threshold.
 *
 * Only the first two exist in the REST API. Probing the endpoints directly:
 *
 *   tpsl/position/place_order   -> reachable (auth error)   native
 *   tpsl/place_order            -> reachable (auth error)   native, takes qty
 *   tpsl/trailing/place_order   -> 404
 *   tpsl/trailing_stop/...      -> 404
 *   trade/trailing_stop         -> 404
 *   tpsl/account/place_order    -> 404
 *
 * So methods 3 and 4 are web/app features with no API behind them, and this
 * module implements them in software against the same semantics the article
 * describes. The practical difference matters and is surfaced to the user:
 * a native order lives on the exchange and fires even if this bot is dead,
 * whereas a software one only works while the manage loop is running. That is
 * why the trailing engine ALSO keeps a native stop underneath as a floor.
 */

// ---------------------------------------------------------------------------
// SHARED: reading the stop back off the exchange
// ---------------------------------------------------------------------------

/**
 * The row carrying the stop that ACTUALLY protects the position.
 *
 * A position can show several pending tp/sl rows at once — the order-attached
 * stop from placeOrder(slPrice=...), the position-level stop, and any partial
 * rungs. They do not agree on the stop price, and they can disagree about which
 * is live. Picking "whichever came first" leaves the original wide stop in
 * charge, so the ratchet in the manager sees no improvement and the position
 * keeps a stop nobody wants.
 *
 * The stop that protects is the MOST protective one for the side: the highest
 * for a LONG (closest to price from below), the lowest for a SHORT. Ties keep
 * the earlier row so the result is stable.
 *
 * Returns null when no row carries a stop.
 */
export function mostProtectiveStopRow(rows, side) {
  const withStop = (rows || []).filter((r) => r && r.slPrice != null);
  if (!withStop.length) return null;
  const isLong = side === 'LONG';
  return withStop.reduce((best, r) => {
    if (best == null) return r;
    const b = Number(best.slPrice);
    const c = Number(r.slPrice);
    if (!Number.isFinite(b)) return r;
    if (!Number.isFinite(c)) return best;
    return (isLong ? c > b : c < b) ? r : best;
  }, null);
}

// ---------------------------------------------------------------------------
// 1. POSITION TP/SL — native, whole position
// ---------------------------------------------------------------------------

/**
 * Attach or update the single position-level TP/SL.
 * Closes the entire position at market when either side triggers.
 */
export async function applyPositionTpSl({ symbol, positionId, tpPrice, slPrice, existing = null }) {
  const body = { symbol, positionId };
  if (tpPrice != null) body.tpPrice = await bitunix.roundPrice(symbol, tpPrice);
  if (slPrice != null) body.slPrice = await bitunix.roundPrice(symbol, slPrice);
  if (body.tpPrice == null && body.slPrice == null) {
    return { ok: false, reason: 'neither tpPrice nor slPrice given' };
  }
  body.tpStopType = 'MARK_PRICE';
  body.slStopType = 'MARK_PRICE';
  try {
    const res = existing
      ? await bitunix.modifyPositionTpSl(body)
      : await bitunix.placePositionTpSl(body);
    return { ok: true, method: 'POSITION', res, tpPrice: body.tpPrice, slPrice: body.slPrice };
  } catch (e) {
    return { ok: false, method: 'POSITION', reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// 2. PARTIAL TP/SL — native, scale out in stages
// ---------------------------------------------------------------------------

/**
 * Place a scale-out ladder of partial take-profits.
 *
 * Each rung is a native tpsl/place_order carrying tpQty, so it closes only its
 * share. The stop stays whole-position: scaling out of a winner is good, but
 * scaling out of a loser just means being wrong more slowly.
 */
export async function applyPartialTpSl({
  symbol, positionId, side, entry, qty, slDist, ladder, liqPrice = null,
}) {
  const steps = typeof ladder === 'string' ? parseLadder(ladder) : (ladder || []);
  if (!steps.length) return { ok: false, reason: 'empty ladder' };

  const isLong = side === 'LONG';
  const info = await bitunix.pairInfo(symbol);
  const minQty = Number(info?.minTradeVolume ?? 0);

  const placed = [];
  const skipped = [];
  let allocated = 0;

  for (const step of steps) {
    const target = isLong ? Number(entry) + slDist * step.r : Number(entry) - slDist * step.r;
    const stepQty = await bitunix.roundQty(symbol, (Number(qty) * step.share) / 100);

    if (minQty && Number(stepQty) < minQty) {
      skipped.push({ ...step, reason: `qty ${stepQty} below minTradeVolume ${minQty}` });
      continue;
    }
    if (allocated + Number(stepQty) > Number(qty)) {
      skipped.push({ ...step, reason: 'would over-allocate the position' });
      continue;
    }

    try {
      const res = await bitunix.placeTpSlOrder({
        symbol,
        positionId,
        tpPrice: await bitunix.roundPrice(symbol, target),
        tpStopType: 'MARK_PRICE',
        tpOrderType: 'MARKET',
        tpQty: String(stepQty),
      });
      allocated += Number(stepQty);
      placed.push({ ...step, qty: stepQty, price: target, orderId: res?.orderId });
    } catch (e) {
      skipped.push({ ...step, reason: e.message });
    }
  }

  const runner = Number(qty) - allocated;
  return {
    ok: placed.length > 0,
    method: 'PARTIAL',
    placed,
    skipped,
    runnerQty: runner > 0 ? runner : 0,
    liqPrice,
  };
}

// ---------------------------------------------------------------------------
// 3. TRAILING TP/SL — software, Bitunix semantics
// ---------------------------------------------------------------------------

/**
 * Per-position trailing state. Kept in memory: a trailing order is only as
 * alive as the loop driving it, and pretending otherwise across a restart
 * would be worse than rebuilding it from the position on the next tick.
 */
const trailState = new Map();   // positionId -> { armed, best, stop }

export function resetTrailing(positionId = null) {
  if (positionId) trailState.delete(positionId);
  else trailState.clear();
}

export function trailingSnapshot() {
  return Object.fromEntries([...trailState.entries()].map(([k, v]) => [k, { ...v }]));
}

/**
 * Bitunix trailing semantics, from the article:
 *
 *   "setting an activation price of 2000 USDT and a 5% retracement range.
 *    When the price climbs to 2000 USDT, the Trailing Take Profit order is
 *    triggered. Should the price rally to 2500 USDT and subsequently pull
 *    back, the system will automatically close the position at market price
 *    once the price falls 5% from the peak of 2500 (2375 USDT)."
 *
 * Two modes, exactly as the web UI offers:
 *   RATIO    — callback is a percentage of the best price   (2500 * 5% = 125)
 *   INTERVAL — callback is an absolute price distance
 *
 * The callback is measured from the BEST price seen since activation, never
 * from entry, and the resulting stop only ever ratchets forward.
 */
export function trailingStep({
  side, entry, price, activationPrice, callback, mode = 'RATIO',
  positionId, liqPrice = null,
}) {
  const isLong = side === 'LONG';
  const key = String(positionId);
  const st = trailState.get(key) || { armed: false, best: null, stop: null };

  // --- activation ---------------------------------------------------------
  if (!st.armed) {
    const reached = isLong ? price >= activationPrice : price <= activationPrice;
    if (!reached) {
      trailState.set(key, st);
      return { armed: false, stop: null, best: null, reason: 'not yet at activation price' };
    }
    st.armed = true;
    st.best = price;
    log.info(`${positionId} trailing armed at ${price} (activation ${activationPrice})`);
  }

  // --- track the extreme --------------------------------------------------
  if (st.best == null) st.best = price;
  if (isLong ? price > st.best : price < st.best) st.best = price;

  // --- callback distance --------------------------------------------------
  const m = String(mode).toUpperCase();
  let dist;
  if (m === 'RATIO') dist = st.best * (Number(callback) / 100);
  else if (m === 'INTERVAL') dist = Number(callback);
  else throw new Error(`unknown trailing mode "${mode}". Valid: RATIO, INTERVAL`);

  let stop = isLong ? st.best - dist : st.best + dist;

  // --- ratchet only -------------------------------------------------------
  if (st.stop != null && (isLong ? stop < st.stop : stop > st.stop)) stop = st.stop;

  // --- never behind liquidation ------------------------------------------
  if (liqPrice) {
    const c = clampStopInsideLiq({ side, entry, slPrice: stop, liqPrice });
    if (c.adjusted) stop = c.slPrice;
  }

  st.stop = stop;
  trailState.set(key, st);

  const triggered = isLong ? price <= stop : price >= stop;
  return {
    armed: true,
    best: st.best,
    stop,
    dist,
    mode: m,
    triggered,
    reason: `trailing ${m === 'RATIO' ? `${callback}%` : callback} from best ${st.best}`,
  };
}

// ---------------------------------------------------------------------------
// 4. ACCOUNT TP/SL — software, across every position
// ---------------------------------------------------------------------------

/**
 * Account-level take-profit / stop-loss.
 *
 * The article: "sets an account-level take-profit trigger when total profits
 * reach 1,000 USDT and an account-level stop-loss trigger when total losses
 * reach 500 USDT ... the system automatically closes all futures positions
 * once the account's overall profit or loss reaches the predefined threshold."
 *
 * There is no endpoint for this, so it is evaluated on every manage tick over
 * the summed unrealised PnL of open positions. Both thresholds are entered as
 * positive USDT amounts; 0 disables that side.
 */
export function evaluateAccountTpSl({ positions, takeProfitUsdt, stopLossUsdt }) {
  const tp = Number(takeProfitUsdt) || 0;
  const sl = Number(stopLossUsdt) || 0;
  if (!tp && !sl) return { hit: false, totalPnl: 0 };

  const totalPnl = (positions || [])
    .reduce((sum, p) => sum + (Number(p.unrealizedPNL) || 0), 0);

  if (tp > 0 && totalPnl >= tp) {
    return {
      hit: true, side: 'TAKE_PROFIT', totalPnl, threshold: tp,
      reason: `account profit ${totalPnl.toFixed(2)} USDT reached the ${tp} USDT target`,
    };
  }
  if (sl > 0 && totalPnl <= -sl) {
    return {
      hit: true, side: 'STOP_LOSS', totalPnl, threshold: sl,
      reason: `account loss ${totalPnl.toFixed(2)} USDT breached the -${sl} USDT limit`,
    };
  }
  return { hit: false, totalPnl };
}

/** Flatten everything. Used when the account-level threshold is hit. */
export async function closeEverything(reason) {
  log.warn(`ACCOUNT TP/SL: closing all positions — ${reason}`);
  try {
    const res = await bitunix.closeAllPositions({});
    resetTrailing();
    return { ok: true, res };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Which method the settings ask for on a fresh entry. */
export function entryMethod() {
  const s = settings();
  const m = String(s.tpsl_method || 'POSITION').toUpperCase();
  return ['POSITION', 'PARTIAL'].includes(m) ? m : 'POSITION';
}
