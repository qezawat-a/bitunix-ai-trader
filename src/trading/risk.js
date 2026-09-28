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
export function clampStopInsideLiq({ side, entry, slPrice, liqPrice, buffer = null }) {
  if (!liqPrice || !Number.isFinite(liqPrice)) return { slPrice, adjusted: false };
  // liq_distance is the user-facing control for this; 0.25 was the old fixed
  // constant. Reading it here means one /set changes every clamp in the system.
  if (buffer == null) buffer = Number(settings().liq_distance ?? 0.5);
  buffer = clamp(Number(buffer), 0.05, 0.9);
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
export function maxSafeLeverage({ entry, slDist, mmr = 0.005, buffer = null }) {
  if (buffer == null) buffer = Number(settings().liq_distance ?? 0.5);
  buffer = clamp(Number(buffer), 0.05, 0.9);
  // Solve |entry - liq| >= slDist / (1 - buffer) for leverage, using the
  // published liq formula: |entry - liq| = entry * (1/lev - MMR).
  const needed = Number(slDist) / (1 - buffer);        // required liq distance
  const frac = needed / Number(entry);                 // as a fraction of price
  const lev = 1 / (frac + Number(mmr));
  return Math.max(1, Math.floor(lev));
}

/**
 * Choose a target from what the tape is actually doing, instead of a fixed
 * multiple of the stop.
 *
 * A fixed R target has one failure mode in each direction: in chop it asks for
 * a move that is not coming, and in a real trend it hands back the part of the
 * move that pays for all the losers. On 20x a 3R target is roughly 100% ROI
 * and the trade is closed — a 25% price run that would have been 500% never
 * gets the chance.
 *
 * So the target widens only when there is evidence to justify it:
 *
 *   strong trend, expanding range   -> NO fixed target; the trailing stop
 *                                      decides when the move is over
 *   trend, but ordinary             -> wide R, scaled by trend strength
 *   squeeze breaking out            -> the measured move (the coiled range
 *                                      projected from the break)
 *   range                           -> the opposite band, and nothing beyond;
 *                                      a range is the one place a runner is
 *                                      simply wrong
 *   weak / no trend                 -> tight, take what is there
 *
 * Returns { tpPrice|null, rr, basis }. A null tpPrice means "let it run" and
 * the caller must ensure a trailing stop is active, otherwise the position has
 * no exit at all.
 */
export function adaptiveTarget({
  side, price, slDist, regime, adx = 0, atrExpansion = 1,
  donHigh = null, donLow = null, trailingEnabled = true,
}) {
  const isLong = side === 'LONG';
  const aligned = isLong ? regime === 'TREND_UP' : regime === 'TREND_DOWN';
  const rrTo = (target) => Math.abs(target - price) / slDist;
  const mk = (target, basis) => ({ tpPrice: target, rr: rrTo(target), basis });

  // --- 1. the runner ------------------------------------------------------
  // Strong directional trend AND a range that is still opening up. Both are
  // required: high ADX on a contracting range is a trend running out of fuel.
  if (aligned && adx >= 30 && atrExpansion >= 1.15) {
    if (trailingEnabled) {
      return { tpPrice: null, rr: null, basis: `trend ADX ${adx.toFixed(0)}, range expanding ${atrExpansion.toFixed(2)}x — no fixed target, trailing it` };
    }
    // Without a trailing stop an open-ended target is an open-ended position.
    const t = isLong ? price + slDist * 8 : price - slDist * 8;
    return mk(t, `strong trend but trailing is off — capped at 8R`);
  }

  // --- 2. range: the other side of the box, never past it -----------------
  if (regime === 'RANGE' && donHigh != null && donLow != null) {
    const band = isLong ? donHigh : donLow;
    const rr = rrTo(band);
    // if the band is closer than the stop the trade is not worth taking on
    // structure alone; fall back to a modest multiple
    if (rr >= 1.2) return mk(band, `range — opposite band at ${band.toFixed(6)}`);
    return mk(isLong ? price + slDist * 1.5 : price - slDist * 1.5, 'range, band too close — 1.5R');
  }

  // --- 3. squeeze break: the measured move --------------------------------
  if (regime === 'SQUEEZE' && donHigh != null && donLow != null) {
    const height = donHigh - donLow;
    if (height > 0) {
      const t = isLong ? price + height : price - height;
      const rr = rrTo(t);
      if (rr >= 1.5) return mk(t, `squeeze — measured move ${height.toFixed(6)}`);
    }
  }

  // --- 4. trending, ordinary ----------------------------------------------
  if (aligned) {
    // ADX 22 -> 3R, ADX 30 -> 5R, flattening off above that
    const rr = clamp(3 + (adx - 22) * 0.25, 3, 5);
    return mk(isLong ? price + slDist * rr : price - slDist * rr,
      `trend ADX ${adx.toFixed(0)} — ${rr.toFixed(1)}R`);
  }

  // --- 5. nothing to lean on ----------------------------------------------
  const rr = adx < 20 ? 1.5 : 2.2;
  return mk(isLong ? price + slDist * rr : price - slDist * rr,
    `no aligned trend (ADX ${adx.toFixed(0)}) — ${rr}R`);
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

  const slPrice = isLong ? price - slDist : price + slDist;

  // tp_mode ADAPTIVE lets the target come from the tape; FIXED_R keeps the
  // original behaviour of a confidence-scaled multiple of the stop.
  let tpPrice;
  let tpBasis;
  let effRr = rr;
  if (String(s.tp_mode || 'ADAPTIVE').toUpperCase() === 'ADAPTIVE') {
    const t = adaptiveTarget({
      side: signal.side, price, slDist, regime,
      adx: Number(signal.adx) || 0,
      atrExpansion: Number(signal.atrExpansion) || 1,
      donHigh: signal.donHigh ?? null,
      donLow: signal.donLow ?? null,
      // Read the real setting rather than hardcoding true: the "no fixed target,
      // let it run" branch is only safe while a trailing stop is actually
      // active. With trailing_method=RATIO/INTERVAL and a position that never
      // reaches its activation price, the open-ended branch would leave the
      // position with a stop but no exit.
      trailingEnabled: String(s.trailing_method || 'ATR').toUpperCase() === 'ATR'
        && Number(s.auto_trade ?? 1) !== 0,
    });
    tpPrice = t.tpPrice;
    tpBasis = t.basis;
    effRr = t.rr;
  } else {
    tpPrice = isLong ? price + slDist * rr : price - slDist * rr;
    tpBasis = `fixed ${rr.toFixed(2)}R`;
  }
  const tpDist = tpPrice == null ? null : Math.abs(tpPrice - price);
  const safeLev = maxSafeLeverage({ entry: price, slDist: atr * kSl, mmr });

  return {
    slPrice,
    tpPrice,
    slDist,
    tpDist,
    tpBasis,
    rr: effRr == null ? null : Number(effRr.toFixed(2)),
    liqPrice,
    liqAdjusted,
    liqNote,
    liqUnsafe,
    maxSafeLeverage: safeLev,
    mmr,
    kSl: Number(kSl.toFixed(2)),
    baseRr: Number(rr.toFixed(2)),
    strength: Number(strength.toFixed(2)),
    slPct: Number(((slDist / price) * 100).toFixed(3)),
    tpPct: tpDist == null ? null : Number(((tpDist / price) * 100).toFixed(3)),
    explain: `ATR ${atr.toFixed(6)} x ${kSl.toFixed(2)} stop, `
      + (tpPrice == null ? 'NO fixed target (trailing)' : `${effRr.toFixed(2)}R target`)
      + ` — ${tpBasis} (strength ${(strength * 100).toFixed(0)}%, regime ${regime})`
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
