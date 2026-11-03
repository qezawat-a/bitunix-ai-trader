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
  // "0" is what the exchange sends for the side a row does not carry: a row
  // with slPrice 0 has NO stop, and ranking it as one (it is the lowest possible
  // price) made every SHORT look like it was already protected at zero.
  const priced = (r) => r && Number(r.slPrice) > 0;
  const withStop = (rows || []).filter(priced);
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

/**
 * The take-profit a live position SHOULD have but does not.
 *
 * Rows that carry a stop but no target leave the position unprotected on the
 * profit side: price runs past the planned TP, comes back, and the stop books
 * a winner as a loss (autopsy: 13 of 14 stop-outs went past their planned TP
 * before the stop hit). The target is the one the trade was opened with, read
 * off its trade record — re-deriving it from today's ATR would move the
 * goalposts on a trade that is already running.
 *
 * With tpsl_method=PARTIAL there is often no single planned target: the rungs
 * ARE the plan, and a rung the exchange would not accept (below its minimum
 * order size) leaves the trade with nothing. For those the shape of the plan is
 * still known — entry, the stop distance and the ladder — so the OUTERMOST rung
 * is returned as the one whole-position target to fall back to.
 *
 * Returns the price to re-attach, or null when there is nothing to restore:
 * a row already carries a target, the record is unavailable, or the trade was
 * opened without a plan (no target and no ladder).
 */
export function missingTakeProfit({ rows, record, ladder = [] }) {
  const hasTp = (rows || []).some((r) => r && Number(r.tpPrice) > 0);
  if (hasTp) return null;
  const planned = Number(record?.tp_price);
  if (Number.isFinite(planned) && planned > 0) return planned;

  const entry = Number(record?.entry_price);
  const sl = Number(record?.sl_price);
  const side = record?.side;
  const steps = Array.isArray(ladder) ? ladder : [];
  const outerR = steps.reduce((m, x) => Math.max(m, Number(x?.r) || 0), 0);
  if (!(entry > 0) || !(sl > 0) || !(outerR > 0) || !(side === 'LONG' || side === 'SHORT')) return null;
  const dist = Math.abs(entry - sl);
  if (!(dist > 0)) return null;
  return side === 'LONG' ? entry + dist * outerR : entry - dist * outerR;
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
 *
 * THE FAILURE THIS FIXES: a rung smaller than the exchange's minimum order size
 * cannot exist as its own order, and it used to be dropped with only a log line.
 * A ~10 USDT position split four ways is a few USDT per rung, so on small
 * accounts EVERY rung was skipped — the trade then had no take-profit at all,
 * price ran past every planned target and died on the stop (autopsy: 13 of 14
 * stop-outs went past their planned TP). A too-small rung is now MERGED into the
 * next one (fewer prices, same shares), and when the position is too small to be
 * split at all, `fallbackTp` carries the outermost rung so the caller can leave
 * ONE whole-position target instead of nothing.
 */
export async function applyPartialTpSl({
  symbol, positionId, side, entry, qty, slDist, ladder, liqPrice = null,
}) {
  const steps = typeof ladder === 'string' ? parseLadder(ladder) : (ladder || []);
  if (!steps.length) return { ok: false, reason: 'empty ladder' };
  const dist = Number(slDist);
  if (!(dist > 0)) return { ok: false, reason: 'no stop distance to size the rungs from' };

  const isLong = side === 'LONG';
  const info = await bitunix.pairInfo(symbol);
  const minQty = Number(info?.minTradeVolume ?? 0);
  const priceAt = (r) => (isLong ? Number(entry) + dist * r : Number(entry) - dist * r);

  const placed = [];
  const skipped = [];
  let allocated = 0;
  let carry = null;   // shares rolled forward from a rung that could not be placed

  for (const step of steps) {
    const share = step.share + (carry?.share || 0);
    const r = step.r;
    const stepQty = await bitunix.roundQty(symbol, (Number(qty) * share) / 100);
    const tooSmall = minQty > 0 && Number(stepQty) < minQty;
    if (tooSmall || allocated + Number(stepQty) > Number(qty)) {
      skipped.push({
        share, r,
        reason: tooSmall
          ? `qty ${stepQty} below minTradeVolume ${minQty} — merged into the next rung`
          : 'would over-allocate the position — merged into the next rung',
      });
      carry = { share, r };
      continue;
    }

    const target = priceAt(r);
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
      placed.push({ share, r, qty: stepQty, price: target, orderId: res?.orderId });
      carry = null;
    } catch (e) {
      skipped.push({ share, r, reason: e.message });
      carry = { share, r };
    }
  }

  const runner = Number(qty) - allocated;
  const outer = steps.reduce((m, x) => Math.max(m, Number(x.r) || 0), 0);
  return {
    ok: placed.length > 0,
    method: 'PARTIAL',
    placed,
    skipped,
    runnerQty: runner > 0 ? runner : 0,
    // The target a caller should fall back to when no rung could be placed.
    fallbackTp: outer > 0 ? priceAt(outer) : null,
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
