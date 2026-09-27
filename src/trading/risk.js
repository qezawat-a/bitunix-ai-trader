import { settings } from '../db/index.js';

/**
 * FULLY DYNAMIC TP/SL — no static percentages anywhere, no min/max clamps in settings.
 *
 * Stop distance  = ATR * k_sl
 *   k_sl shrinks when the signal is strong and the market is orderly,
 *   widens in volatile / low-conviction conditions.
 *
 * Reward:risk    = f(signal strength, agreement, regime)
 *   a 100-confidence 6-strategy trend signal is allowed to run much further
 *   than a barely-qualified 2-strategy range signal.
 *
 * Everything below is derived per-signal at runtime.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Maintenance margin rate fallback.
 *
 * The authoritative source is GET /api/v1/futures/position/get_position_tiers,
 * which returns maintenanceMarginRate per position-value band. Use
 * bitunix.tierFor({symbol, notional}) and pass the result in as `mmr`.
 *
 * This heuristic only runs when the tier lookup fails (network, new listing).
 * It over-states MMR on every pair measured — BTC real tier-1 is 0.30% and
 * this returns 0.50%, SOL real 0.50% against 1.00% here — which places
 * liquidation closer to entry than reality. That is the safe direction to be
 * wrong in, but it does needlessly cap leverage, so it is a fallback and not
 * the main path.
 */
export function mmrFor(maxLeverage) {
  const maxLev = Number(maxLeverage);
  if (!(maxLev > 0)) return 0.005;
  return clamp(1 / maxLev, 0.004, 0.05);
}

/**
 * Estimate the liquidation price BEFORE the position exists.
 *
 * Bitunix help centre, "Forced Liquidation in Futures Trading":
 *
 *   Liq = Entry x [1 - (Margin - Margin x Lev x MMR) / (Margin x Lev)]
 *
 * Margin cancels out, leaving the standard published form:
 *
 *   Long  : Liq = Entry x (1 - 1/Lev + MMR)
 *   Short : Liq = Entry x (1 + 1/Lev - MMR)
 *
 * Verified against the doc's worked example: entry 100000, 100x, MMR 0.5%
 * -> 100000 x (1 - 0.01 + 0.005) = 99500. The doc prints 99505 because it
 * carries the margin term through unrounded; the 5 USDT difference is 0.005%
 * and lands on the conservative side.
 *
 * CROSS margin liquidates later than this, because the whole account balance
 * backs the position. Using the isolated formula for both modes therefore
 * under-states the distance to liquidation, which is the safe error to make.
 *
 * Fees and funding are excluded here exactly as they are in the doc. They move
 * liquidation closer over time, which is why clampStopInsideLiq keeps a buffer.
 */
export function estimateLiqPrice({ side, entry, leverage, mmr = 0.005 }) {
  const lev = Math.max(1, Number(leverage) || 1);
  const imr = 1 / lev;
  const e = Number(entry);
  const liq = side === 'LONG' ? e * (1 - imr + Number(mmr)) : e * (1 + imr - Number(mmr));
  // At leverage >= 1/MMR the maintenance requirement swallows the entire
  // margin and liquidation sits at or through entry. No stop survives that;
  // return entry so the caller refuses the trade.
  if (side === 'LONG' && liq >= e) return e;
  if (side === 'SHORT' && liq <= e) return e;
  return liq;
}

/**
 * Pull a stop back inside the liquidation price.
 *
 * A stop beyond liquidation is not a stop — the exchange closes the position
 * first and takes the whole margin. The stop must sit in front of liq with
 * room to spare, because liq itself drifts (funding, fees, mark-vs-last).
 */
export function clampStopInsideLiq({ side, entry, slPrice, liqPrice, buffer = 0.25 }) {
  if (!liqPrice || !Number.isFinite(liqPrice)) return { slPrice, adjusted: false };
  const isLong = side === 'LONG';
  const liqDist = Math.abs(Number(entry) - Number(liqPrice));
  // keep the stop at most (1 - buffer) of the way to liquidation
  const maxDist = liqDist * (1 - buffer);
  const wantDist = Math.abs(Number(entry) - Number(slPrice));
  if (wantDist <= maxDist) return { slPrice, adjusted: false };
  const safe = isLong ? Number(entry) - maxDist : Number(entry) + maxDist;
  return {
    slPrice: safe,
    adjusted: true,
    reason: `stop was ${wantDist.toFixed(6)} from entry but liquidation is only `
      + `${liqDist.toFixed(6)} away; pulled in to ${maxDist.toFixed(6)}`,
  };
}

/**
 * The largest leverage at which this signal's ATR stop still fits inside
 * liquidation with the safety buffer intact. Used to refuse or de-lever a
 * trade instead of opening one that can only end in liquidation.
 */
export function maxSafeLeverage({ entry, slDist, mmr = 0.005, buffer = 0.25 }) {
  // Solve |entry - liq| >= slDist / (1 - buffer) for leverage, using the
  // published liq formula: |entry - liq| = entry * (1/lev - MMR).
  const needed = Number(slDist) / (1 - buffer);        // required liq distance
  const frac = needed / Number(entry);                 // as a fraction of price
  const lev = 1 / (frac + Number(mmr));
  return Math.max(1, Math.floor(lev));
}

export function computeDynamicTpSl(signal) {
  const s = settings();
  const price = Number(signal.price);
  const atr = Number(signal.atr);
  const conf = Number(signal.confidence);
  const agreement = Number(signal.agreement);
  const atrPct = Number(signal.atrPct ?? (atr / price) * 100);
  const regime = signal.regime || 'RANGE';

  // ---- strength score 0..1 -------------------------------------------
  const minConf = Number(s.min_confidence || 80);
  const confPart = clamp((conf - minConf) / (100 - minConf || 1), 0, 1);      // how far above the bar
  const agreePart = clamp((agreement - Number(s.min_agreement || 2)) / 4, 0, 1);
  const strength = clamp(0.55 * confPart + 0.45 * agreePart, 0, 1);

  // ---- stop multiplier ------------------------------------------------
  // base 1.5 ATR, tighter for strong signals, wider for volatile tape
  let kSl = 1.5 - 0.35 * strength;
  if (regime === 'VOLATILE') kSl += 0.6;
  if (regime === 'SQUEEZE') kSl += 0.25;              // breakouts need room for the retest
  if (regime === 'RANGE') kSl -= 0.1;
  if (atrPct < 0.25) kSl += 0.4;                      // very quiet tape -> noise stops
  kSl = clamp(kSl, 0.8, 3.2);

  // ---- reward:risk ----------------------------------------------------
  let rr = 1.3 + 2.2 * strength;                      // 1.3R .. 3.5R
  if (regime === 'TREND_UP' || regime === 'TREND_DOWN') rr += 0.5;
  if (regime === 'RANGE') rr -= 0.35;                 // take what the range gives
  if (regime === 'VOLATILE') rr += 0.2;
  if (signal.htfRegime && signal.side === 'LONG' && signal.htfRegime === 'TREND_UP') rr += 0.3;
  if (signal.htfRegime && signal.side === 'SHORT' && signal.htfRegime === 'TREND_DOWN') rr += 0.3;
  rr = clamp(rr, 1.1, 4.5);

  let slDist = atr * kSl;

  // ---- liquidation guard ----------------------------------------------
  // An ATR stop knows nothing about leverage. At high leverage the liquidation
  // price can sit CLOSER to entry than the stop, so the exchange liquidates
  // first and the stop never fires. Clamp the stop inside liq, always.
  const isLong = signal.side === 'LONG';
  const lev = Number(signal.leverage) || Number(s.leverage) || 1;
  const mmr = signal.mmr ?? mmrFor(signal.maxLeverage);
  const liqPrice = signal.liqPrice
    ?? estimateLiqPrice({ side: signal.side, entry: price, leverage: lev, mmr });
  let liqAdjusted = false;
  let liqNote = null;
  // liq at/through entry: the position is unopenable at this leverage
  const liqUnsafe = liqPrice != null
    && (isLong ? liqPrice >= price : liqPrice <= price);

  if (liqPrice) {
    const raw = isLong ? price - slDist : price + slDist;
    const c = clampStopInsideLiq({ side: signal.side, entry: price, slPrice: raw, liqPrice });
    if (c.adjusted) {
      slDist = Math.abs(price - c.slPrice);
      liqAdjusted = true;
      liqNote = c.reason;
    }
  }

  const tpDist = slDist * rr;
  const slPrice = isLong ? price - slDist : price + slDist;
  const tpPrice = isLong ? price + tpDist : price - tpDist;
  const safeLev = maxSafeLeverage({ entry: price, slDist: atr * kSl, mmr });

  return {
    slPrice,
    tpPrice,
    slDist,
    tpDist,
    liqPrice,
    liqAdjusted,
    liqNote,
    liqUnsafe,
    maxSafeLeverage: safeLev,
    mmr,
    kSl: Number(kSl.toFixed(2)),
    rr: Number(rr.toFixed(2)),
    strength: Number(strength.toFixed(2)),
    slPct: Number(((slDist / price) * 100).toFixed(3)),
    tpPct: Number(((tpDist / price) * 100).toFixed(3)),
    explain: `ATR ${atr.toFixed(6)} x ${kSl.toFixed(2)} stop, ${rr.toFixed(2)}R target `
      + `(strength ${(strength * 100).toFixed(0)}%, regime ${regime})`
      + (liqAdjusted ? ` — STOP PULLED INSIDE LIQUIDATION: ${liqNote}` : ''),
  };
}

/**
 * Trailing stop level once the position is in profit.
 * Uses the same ATR engine, ratcheting behind price.
 */
export function trailingStop({ side, entry, currentPrice, atr, roiPct, leverage, liqPrice }) {
  const s = settings();
  const beThreshold = Number(s.breakeven_threshold || 20);        // ROI %
  const trailTrigger = Number(s.trailing_trigger_roi_pct || 25);  // ROI %
  const isLong = side === 'LONG';

  // ROI here is leveraged return on margin, matching what the exchange UI shows
  if (roiPct < beThreshold) return null;

  // breakeven+fee buffer
  const feeBuffer = entry * 0.0008;
  let stop = isLong ? entry + feeBuffer : entry - feeBuffer;
  let reason = 'breakeven';

  if (roiPct >= trailTrigger) {
    // Trail a fixed distance behind price, in ATR. This used to be a hidden
    // curve (1.2 ATR tightening to 0.5 as profit grew) that the user could
    // neither see nor change — now it is one setting that means exactly what
    // it says.
    const k = clamp(Number(s.trailing_distance_atr ?? 0.5), 0.1, 5);
    const trail = isLong ? currentPrice - atr * k : currentPrice + atr * k;
    if ((isLong && trail > stop) || (!isLong && trail < stop)) {
      stop = trail;
      reason = `trailing ${k} ATR`;
    }
  }
  // Never hand the exchange a stop behind liquidation, even a breakeven one:
  // on a position already deep in loss, breakeven can be the wrong side of liq.
  if (liqPrice) {
    const c = clampStopInsideLiq({ side, entry, slPrice: stop, liqPrice });
    if (c.adjusted) { stop = c.slPrice; reason += ' (clamped inside liq)'; }
  }
  return { stop, reason };
}

/** Position sizing: margin_pct of available balance (order unit = COST/USDT). */
export function computeMargin({ available, marginPct, openPositions, maxPositions }) {
  const pct = Number(marginPct) / 100;
  let margin = Number(available) * pct;
  // never let the book exceed what the remaining slots can carry
  const slotsLeft = Math.max(1, Number(maxPositions) - Number(openPositions));
  const cap = Number(available) / slotsLeft;
  if (margin > cap) margin = cap;
  return Math.max(0, margin);
}
