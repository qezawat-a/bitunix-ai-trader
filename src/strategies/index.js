import * as I from './indicators.js';

/**
 * TEN strategies, chosen to cover every market regime a perpetual-futures
 * book can be in (research-backed classic families, adapted to crypto perps):
 *
 *  1. trend_supertrend   - trend following  (Supertrend + EMA200 + ADX)
 *  2. momentum_macd      - momentum         (MACD + RSI + volume expansion)
 *  3. squeeze_breakout   - volatility breakout (BB/KC squeeze + Donchian break)
 *  4. vwap_reversion     - mean reversion   (VWAP deviation + StochRSI exhaustion)
 *  5. ema_pullback       - trend pullback   (EMA20/50 stack + shallow retrace)
 *  6. orderflow_funding  - order-flow / carry (book imbalance + funding skew)
 *  7. rsi_divergence     - reversal         (confirmed pivot + RSI divergence)
 *  8. bollinger_bounce   - mean reversion   (band pierce-and-reject, not a touch)
 *  9. atr_channel_break  - breakout         (Donchian range widened by k x ATR)
 * 10. volume_profile     - volume structure (point of control + OBV divergence)
 *
 * Every strategy returns:  { name, side: 'LONG'|'SHORT'|null, confidence: 0..100, notes: [] }
 * Confidence is *self-assessed strength*, later re-weighted by live performance
 * (strategy_stats.weight) and cross-checked by the LLM.
 */

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const NONE = (name, why) => ({ name, side: null, confidence: 0, notes: [why] });

// --------------------------------------------------------------- 1. TREND
export function trendSupertrend(c) {
  const name = 'trend_supertrend';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high), lows = c.map((x) => x.low);
  if (closes.length < 210) return NONE(name, 'not enough candles');

  const st = I.supertrend(highs, lows, closes, 10, 3);
  const dir = I.last(st.dir);
  const prevDir = I.prev(st.dir);
  const ema200 = I.last(I.ema(closes, 200));
  const ema50 = I.last(I.ema(closes, 50));
  const { adx } = I.adx(highs, lows, closes, 14);
  const a = I.last(adx) ?? 0;
  const price = I.last(closes);
  if (dir == null || ema200 == null) return NONE(name, 'indicators warming up');

  const notes = [`ST dir=${dir}`, `ADX=${a.toFixed(1)}`, `EMA50/200=${ema50 > ema200 ? 'bull' : 'bear'}`];
  let side = null, conf = 0;

  if (dir === 1 && price > ema200 && ema50 > ema200) {
    side = 'LONG';
    conf = 45 + Math.min(30, a) + (prevDir === -1 ? 15 : 0) + (I.slope(closes, 20) > 0 ? 8 : 0);
  } else if (dir === -1 && price < ema200 && ema50 < ema200) {
    side = 'SHORT';
    conf = 45 + Math.min(30, a) + (prevDir === 1 ? 15 : 0) + (I.slope(closes, 20) < 0 ? 8 : 0);
  } else {
    return NONE(name, 'trend filters disagree');
  }
  if (a < 18) { conf -= 20; notes.push('weak ADX'); }
  return { name, side, confidence: clamp(conf), notes };
}

// ------------------------------------------------------------ 2. MOMENTUM
export function momentumMacd(c) {
  const name = 'momentum_macd';
  const closes = c.map((x) => x.close), vols = c.map((x) => x.volume);
  if (closes.length < 60) return NONE(name, 'not enough candles');

  const m = I.macd(closes, 12, 26, 9);
  const hist = I.last(m.hist), hist1 = I.prev(m.hist), hist2 = I.prev(m.hist, 2);
  const r = I.last(I.rsi(closes, 14));
  const vz = I.volumeZ(vols, 20);
  if (hist == null || hist1 == null || r == null) return NONE(name, 'indicators warming up');

  const rising = hist > hist1 && hist1 > hist2;
  const falling = hist < hist1 && hist1 < hist2;
  const crossUp = hist > 0 && hist1 <= 0;
  const crossDown = hist < 0 && hist1 >= 0;
  const notes = [`hist=${hist.toFixed(6)}`, `RSI=${r.toFixed(1)}`, `volZ=${vz.toFixed(2)}`];

  let side = null, conf = 0;
  if ((crossUp || (hist > 0 && rising)) && r > 50 && r < 78) {
    side = 'LONG';
    conf = 50 + (crossUp ? 18 : 10) + clamp(vz * 8, 0, 18) + clamp((r - 50) * 0.6, 0, 12);
  } else if ((crossDown || (hist < 0 && falling)) && r < 50 && r > 22) {
    side = 'SHORT';
    conf = 50 + (crossDown ? 18 : 10) + clamp(vz * 8, 0, 18) + clamp((50 - r) * 0.6, 0, 12);
  } else {
    return NONE(name, 'no momentum impulse');
  }
  if (vz < -0.5) { conf -= 15; notes.push('volume drying up'); }
  return { name, side, confidence: clamp(conf), notes };
}

// ----------------------------------------------------- 3. SQUEEZE BREAKOUT
export function squeezeBreakout(c) {
  const name = 'squeeze_breakout';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high),
    lows = c.map((x) => x.low), vols = c.map((x) => x.volume);
  if (closes.length < 60) return NONE(name, 'not enough candles');

  const bb = I.bollinger(closes, 20, 2);
  const kc = I.keltner(highs, lows, closes, 20, 1.5);
  const dc = I.donchian(highs, lows, 20);
  const price = I.last(closes);
  const vz = I.volumeZ(vols, 20);

  const wasSqueezed = (n) => {
    const i = closes.length - 1 - n;
    return bb.upper[i] != null && kc.upper[i] != null
      && bb.upper[i] < kc.upper[i] && bb.lower[i] > kc.lower[i];
  };
  const squeezedRecently = [1, 2, 3, 4, 5].some(wasSqueezed);
  const inSqueeze = wasSqueezed(0);
  if (!squeezedRecently && !inSqueeze) return NONE(name, 'no volatility compression');
  if (inSqueeze) return NONE(name, 'still compressed, waiting for release');

  const upper = I.prev(dc.upper), lower = I.prev(dc.lower);
  const notes = [`donchian=${lower?.toFixed(4)}..${upper?.toFixed(4)}`, `volZ=${vz.toFixed(2)}`];

  let side = null, conf = 0;
  if (upper && price > upper) {
    side = 'LONG';
    conf = 58 + clamp(vz * 10, 0, 25) + clamp(((price / upper - 1) * 1000), 0, 10);
  } else if (lower && price < lower) {
    side = 'SHORT';
    conf = 58 + clamp(vz * 10, 0, 25) + clamp(((lower / price - 1) * 1000), 0, 10);
  } else {
    return NONE(name, 'squeeze released but no range break');
  }
  if (vz < 0.3) { conf -= 18; notes.push('break without volume'); }
  return { name, side, confidence: clamp(conf), notes };
}

// ------------------------------------------------------ 4. VWAP REVERSION
export function vwapReversion(c) {
  const name = 'vwap_reversion';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high),
    lows = c.map((x) => x.low), vols = c.map((x) => x.volume);
  if (closes.length < 60) return NONE(name, 'not enough candles');

  const win = 60;
  const v = I.vwap(highs.slice(-win), lows.slice(-win), closes.slice(-win), vols.slice(-win));
  const vw = I.last(v);
  const price = I.last(closes);
  const a = I.last(I.atr(highs, lows, closes, 14));
  const { adx } = I.adx(highs, lows, closes, 14);
  const adxV = I.last(adx) ?? 0;
  const { k, d } = I.stochRsi(closes);
  const kv = I.last(k), dv = I.last(d);
  if (!vw || !a || kv == null) return NONE(name, 'indicators warming up');

  // mean reversion only makes sense when the market is NOT trending hard
  if (adxV > 28) return NONE(name, `trending (ADX ${adxV.toFixed(1)}), reversion disabled`);

  const dev = (price - vw) / a; // deviation in ATR units
  const notes = [`vwapDev=${dev.toFixed(2)} ATR`, `stochK=${kv.toFixed(1)}`, `ADX=${adxV.toFixed(1)}`];

  let side = null, conf = 0;
  if (dev <= -1.6 && kv < 25 && kv > dv) {
    side = 'LONG';
    conf = 55 + clamp((Math.abs(dev) - 1.6) * 18, 0, 22) + clamp((25 - kv), 0, 12);
  } else if (dev >= 1.6 && kv > 75 && kv < dv) {
    side = 'SHORT';
    conf = 55 + clamp((dev - 1.6) * 18, 0, 22) + clamp((kv - 75), 0, 12);
  } else {
    return NONE(name, 'price not stretched from VWAP');
  }
  return { name, side, confidence: clamp(conf), notes };
}

// -------------------------------------------------------- 5. EMA PULLBACK
export function emaPullback(c) {
  const name = 'ema_pullback';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high), lows = c.map((x) => x.low);
  if (closes.length < 120) return NONE(name, 'not enough candles');

  const e20 = I.ema(closes, 20), e50 = I.ema(closes, 50);
  const e20v = I.last(e20), e50v = I.last(e50);
  const price = I.last(closes);
  const a = I.last(I.atr(highs, lows, closes, 14));
  const r = I.last(I.rsi(closes, 14));
  const { adx } = I.adx(highs, lows, closes, 14);
  const adxV = I.last(adx) ?? 0;
  if (!e20v || !e50v || !a) return NONE(name, 'indicators warming up');
  if (adxV < 20) return NONE(name, 'no trend to pull back into');

  const distToE20 = Math.abs(price - e20v) / a;
  const notes = [`ADX=${adxV.toFixed(1)}`, `dist20=${distToE20.toFixed(2)} ATR`, `RSI=${r?.toFixed(1)}`];

  let side = null, conf = 0;
  const bullStack = e20v > e50v && price > e50v;
  const bearStack = e20v < e50v && price < e50v;

  if (bullStack && distToE20 < 0.8 && r > 40 && r < 65 && I.last(lows) <= e20v * 1.002) {
    side = 'LONG';
    conf = 56 + clamp(adxV - 20, 0, 20) + clamp((0.8 - distToE20) * 20, 0, 12);
  } else if (bearStack && distToE20 < 0.8 && r < 60 && r > 35 && I.last(highs) >= e20v * 0.998) {
    side = 'SHORT';
    conf = 56 + clamp(adxV - 20, 0, 20) + clamp((0.8 - distToE20) * 20, 0, 12);
  } else {
    return NONE(name, 'no clean pullback');
  }
  return { name, side, confidence: clamp(conf), notes };
}

// ------------------------------------------------ 6. ORDER FLOW + FUNDING
/**
 * Needs live context: order book depth + funding rate.
 * ctx = { depth: {asks:[[p,q]], bids:[[p,q]]}, funding: {fundingRate, nextFundingTime} }
 */
export function orderflowFunding(c, ctx = {}) {
  const name = 'orderflow_funding';
  const closes = c.map((x) => x.close);
  if (closes.length < 30) return NONE(name, 'not enough candles');
  const { depth, funding } = ctx;
  if (!depth?.bids?.length || !depth?.asks?.length) return NONE(name, 'no order book');

  const topN = 15;
  const bidVol = depth.bids.slice(0, topN).reduce((s, [, q]) => s + Number(q), 0);
  const askVol = depth.asks.slice(0, topN).reduce((s, [, q]) => s + Number(q), 0);
  const imb = (bidVol - askVol) / (bidVol + askVol || 1);      // -1 .. +1
  // Bitunix reports fundingRate ALREADY IN PERCENT, not as a decimal fraction.
  // The proof is in the same payload: maxFundingRate is 0.3 / 0.4875 / 2, which
  // as fractions would be 30% / 49% / 200% per 8h. So 0.01 means 0.01%.
  //
  // This was read as a fraction and compared against 0.0006. Measured across
  // all 895 pairs, that flagged 81% of them as permanently "crowded", which
  // both suppressed the ordinary LONG branch (it requires !crowdedLong) and
  // fired the fade branches constantly. Normal funding is around 0.01%; the
  // thresholds below sit at 3x that, which selects ~5% of pairs.
  const frPct = Number(funding?.fundingRate ?? 0);              // percent, e.g. 0.01 = 0.01%
  const sl = I.slope(closes, 20);
  const notes = [`imbalance=${(imb * 100).toFixed(1)}%`, `funding=${frPct.toFixed(4)}%`, `slope=${sl.toFixed(3)}`];

  let side = null, conf = 0;
  // Crowded longs (very positive funding) + selling book pressure -> fade to SHORT.
  // Crowded shorts (very negative funding) + buying book pressure -> fade to LONG.
  const CROWDED_PCT = 0.03;                                     // 3x a normal 0.01% rate
  const crowdedLong = frPct > CROWDED_PCT;
  const crowdedShort = frPct < -CROWDED_PCT;

  if (imb > 0.22 && !crowdedLong && sl >= 0) {
    side = 'LONG';
    conf = 52 + clamp(imb * 60, 0, 24) + (crowdedShort ? 14 : 0);
  } else if (imb < -0.22 && !crowdedShort && sl <= 0) {
    side = 'SHORT';
    conf = 52 + clamp(Math.abs(imb) * 60, 0, 24) + (crowdedLong ? 14 : 0);
  } else if (crowdedLong && imb < -0.1) {
    side = 'SHORT'; conf = 60 + clamp(Math.abs(imb) * 40, 0, 18);
    notes.push('fading crowded longs');
  } else if (crowdedShort && imb > 0.1) {
    side = 'LONG'; conf = 60 + clamp(imb * 40, 0, 18);
    notes.push('fading crowded shorts');
  } else {
    return NONE(name, 'book balanced / funding neutral');
  }
  return { name, side, confidence: clamp(conf), notes };
}

// ------------------------------------------------ 7. RSI DIVERGENCE
/**
 * RSI divergence, on its own rather than as a filter.
 *
 * The existing six use RSI only to veto a momentum read. This one is a separate
 * family: it looks for price making a new extreme while momentum fails to
 * confirm it — the classic exhaustion tell, and the one that fires EARLIEST in
 * a reversal. Divergences are noisy on short timeframes, so it requires a
 * confirmed pivot (a bar that is the extreme of the N bars either side) rather
 * than comparing arbitrary bars, and it stands down in a strong trend where
 * divergences persist for a long time before resolving.
 */
export function rsiDivergence(c) {
  const name = 'rsi_divergence';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high), lows = c.map((x) => x.low);
  if (closes.length < 120) return NONE(name, 'not enough candles');

  const r = I.rsi(closes, 14);
  const a = I.last(I.atr(highs, lows, closes, 14));
  const { adx } = I.adx(highs, lows, closes, 14);
  const adxV = I.last(adx) ?? 0;
  const rv = I.last(r);
  if (!a || rv == null) return NONE(name, 'indicators warming up');

  const PIVOT = 5;                 // bars either side that must not exceed the pivot
  const LOOKBACK = 60;
  const price = I.last(closes);

  /** Index of the most recent confirmed pivot high/low, or -1. */
  const lastPivot = (arr, i, isHigh) => {
    for (let j = i; j >= arr.length - PIVOT - 1 && j >= arr.length - LOOKBACK; j--) {
      let isPivot = true;
      for (let k = j - PIVOT; k <= j + PIVOT; k++) {
        if (k < 0 || k >= arr.length || k === j) continue;
        if (isHigh ? arr[k] > arr[j] : arr[k] < arr[j]) { isPivot = false; break; }
      }
      if (isPivot) return j;
    }
    return -1;
  };

  const i1 = closes.length - 1 - PIVOT;   // the older bar, still inside the window
  if (i1 < 30) return NONE(name, 'not enough confirmed pivots');

  const ph2 = lastPivot(highs, closes.length - 1, true);
  const pl2 = lastPivot(lows, closes.length - 1, false);
  const ph1 = ph2 >= 0 && ph2 > i1 ? lastPivot(highs, ph2 - 1, true) : -1;
  const pl1 = pl2 >= 0 && pl2 > i1 ? lastPivot(lows, pl2 - 1, false) : -1;

  const notes = [`RSI=${rv.toFixed(1)}`, `ADX=${adxV.toFixed(1)}`];
  let side = null, conf = 0;

  // Bearish: higher price high, lower RSI high
  if (ph1 >= 0 && ph2 >= 0 && highs[ph2] > highs[ph1] && r[ph2] < r[ph1] && rv < 60) {
    side = 'SHORT';
    const pxDiv = ((highs[ph2] / highs[ph1]) - 1) * 100;
    const rDiv = r[ph1] - r[ph2];
    conf = 52 + clamp(Math.abs(rDiv) * 1.6, 0, 22) + clamp(pxDiv * 220, 0, 14);
    notes.push(`bearish divergence: price +${pxDiv.toFixed(2)}%, RSI -${rDiv.toFixed(1)}`);
  } else if (pl1 >= 0 && pl2 >= 0 && lows[pl2] < lows[pl1] && r[pl2] > r[pl1] && rv > 40) {
    // Bullish: lower price low, higher RSI low
    side = 'LONG';
    const pxDiv = ((lows[pl1] - lows[pl2]) / lows[pl1]) * 100;
    const rDiv = r[pl2] - r[pl1];
    conf = 52 + clamp(Math.abs(rDiv) * 1.6, 0, 22) + clamp(pxDiv * 220, 0, 14);
    notes.push(`bullish divergence: price -${pxDiv.toFixed(2)}%, RSI +${rDiv.toFixed(1)}`);
  } else {
    return NONE(name, 'no confirmed divergence');
  }

  // A divergence inside a strong trend is a warning, not a signal: price can
  // keep making new extremes against a falling RSI for a long time.
  if (adxV > 32) { conf -= 20; notes.push(`strong trend ADX ${adxV.toFixed(0)} — divergence unreliable`); }
  return { name, side, confidence: clamp(conf), notes };
}

// -------------------------------------------- 8. BOLLINGER BOUNCE
/**
 * Band reversion, distinct from vwap_reversion: that one fades distance from
 * VWAP in a flat book, this one waits for the band TAG plus a failed close
 * outside it. "Touched the band" alone is not a signal — a strong trend rides
 * the upper band for hours. What makes it one is a bar that pierces the band
 * and closes back inside, i.e. the level held.
 */
export function bollingerBounce(c) {
  const name = 'bollinger_bounce';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high), lows = c.map((x) => x.low);
  if (closes.length < 60) return NONE(name, 'not enough candles');

  const bb = I.bollinger(closes, 20, 2);
  const a = I.last(I.atr(highs, lows, closes, 14));
  const { adx } = I.adx(highs, lows, closes, 14);
  const adxV = I.last(adx) ?? 0;
  const r = I.last(I.rsi(closes, 14));
  const price = I.last(closes);
  const n = closes.length - 1;
  if (!a || bb.upper[n] == null || r == null) return NONE(name, 'indicators warming up');

  // Band walking: 3+ consecutive closes beyond the band is a trend, not a bounce.
  const outside = (i, dir) => (dir > 0 ? closes[i] > bb.upper[i] : closes[i] < bb.lower[i]);
  const runLen = (dir) => {
    let k = 0;
    for (let i = n; i >= 0 && outside(i, dir); i--) k++;
    return k;
  };
  const upRun = runLen(1), downRun = runLen(-1);

  const widthNow = bb.width[n];
  const widthAvg = I.sma(bb.width.filter((x) => x != null), 50);
  const wAvg = I.last(widthAvg);
  const widthRank = wAvg ? widthNow / wAvg : 1;

  const notes = [`bbWidth=${(widthNow * 100).toFixed(2)}% (${widthRank.toFixed(2)}x avg)`,
    `ADX=${adxV.toFixed(1)}`, `RSI=${r.toFixed(1)}`];
  let side = null, conf = 0;

  if (downRun >= 1 && downRun <= 2 && r < 42) {
    // pierced the lower band and closed back inside it
    side = 'LONG';
    const pierce = (bb.lower[n] - lows[n]) / a;      // how far through, in ATR
    conf = 54 + clamp(Math.abs(pierce) * 14, 0, 18) + clamp((42 - r) * 0.7, 0, 14);
    if (adxV > 30) { conf -= 18; notes.push('trending hard — bounce unreliable'); }
    notes.push(`closed back inside lower band after ${downRun} bar(s) below`);
  } else if (upRun >= 1 && upRun <= 2 && r > 58) {
    side = 'SHORT';
    const pierce = (highs[n] - bb.upper[n]) / a;
    conf = 54 + clamp(Math.abs(pierce) * 14, 0, 18) + clamp((r - 58) * 0.7, 0, 14);
    if (adxV > 30) { conf -= 18; notes.push('trending hard — bounce unreliable'); }
    notes.push(`closed back inside upper band after ${upRun} bar(s) above`);
  } else if (downRun > 2) {
    return NONE(name, `riding the lower band ${downRun} bars — trend, not a bounce`);
  } else if (upRun > 2) {
    return NONE(name, `riding the upper band ${upRun} bars — trend, not a bounce`);
  } else {
    return NONE(name, 'no band rejection');
  }

  // Squeeze context: a narrow band right before the expansion makes the
  // rejection far more meaningful than a rejection inside an already-wide band.
  if (widthRank < 0.8) { conf += 10; notes.push('band was compressed — expansion from a squeeze'); }
  return { name, side, confidence: clamp(conf), notes };
}

// ---------------------------------------- 9. ATR CHANNEL BREAKOUT
/**
 * Breakout sized by volatility rather than by a fixed lookback.
 *
 * squeeze_breakout needs a Keltner/Bollinger squeeze first, so it is silent
 * most of the time. This one fires on any decisive break of an ATR envelope
 * around the recent range, which is what actually happens in the trending tape
 * that a squeeze detector misses. The channel is the Donchian range widened or
 * narrowed by k*ATR, so it tightens on a quiet market and widens on a violent
 * one instead of being a fixed percentage.
 */
export function atrChannelBreak(c) {
  const name = 'atr_channel_break';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high),
    lows = c.map((x) => x.low), vols = c.map((x) => x.volume);
  if (closes.length < 60) return NONE(name, 'not enough candles');

  const dc = I.donchian(highs, lows, 20);
  const a = I.last(I.atr(highs, lows, closes, 14));
  const price = I.last(closes);
  const vz = I.volumeZ(vols, 20);
  const n = closes.length - 1;
  if (!a || dc.upper[n] == null) return NONE(name, 'indicators warming up');

  // The PREVIOUS bar's channel, so the current bar has to break it — using
  // today's channel would include today's own high and never break out.
  const pu = dc.upper[n - 1], pl = dc.lower[n - 1];
  const k = 0.25;
  const chanHi = pu + a * k, chanLo = pl - a * k;

  // A close a hundredth of an ATR past the channel is noise, not a breakout.
  // Without this floor the strategy fires on every tick of a drifting market
  // and reports 56 confidence for a move that has not happened yet.
  const MIN_BREAK = 0.15;

  const notes = [`channel=${chanLo.toFixed(6)}..${chanHi.toFixed(6)}`, `ATR=${a.toFixed(6)}`, `volZ=${vz.toFixed(2)}`];
  let side = null, conf = 0;

  if (price > chanHi && (price - chanHi) / a < MIN_BREAK) {
    return NONE(name, `only ${((price - chanHi) / a).toFixed(2)} ATR past the channel — below the ${MIN_BREAK} floor`);
  } else if (price < chanLo && (chanLo - price) / a < MIN_BREAK) {
    return NONE(name, `only ${((chanLo - price) / a).toFixed(2)} ATR past the channel — below the ${MIN_BREAK} floor`);
  }

  if (price > chanHi) {
    side = 'LONG';
    const through = (price - chanHi) / a;
    conf = 56 + clamp(through * 90, 0, 20) + clamp(vz * 9, 0, 18);
    notes.push(`broke ${(through).toFixed(2)} ATR above the channel`);
  } else if (price < chanLo) {
    side = 'SHORT';
    const through = (chanLo - price) / a;
    conf = 56 + clamp(through * 90, 0, 20) + clamp(vz * 9, 0, 18);
    notes.push(`broke ${(through).toFixed(2)} ATR below the channel`);
  } else {
    return NONE(name, 'inside the channel');
  }

  // A break with no volume behind it is a stop-run, not a breakout.
  if (vz < 0.3) { conf -= 20; notes.push('no volume behind the break'); }
  return { name, side, confidence: clamp(conf), notes };
}

// ------------------------------------------------ 10. VOLUME PROFILE
/**
 * Where the volume actually traded, and whether the tape agrees with price.
 *
 * Two halves, and the second is the one that trades:
 *   POC  — the price bucket holding the most traded volume over the window.
 *          Price rejecting from it is a level the market defended.
 *   OBV  — on-balance volume. Price up + OBV down is divergence: the move is
 *          being sold into. That is a different fact from an RSI divergence
 *          (which is derived from the same closes) because OBV is built from
 *          volume, so it disagrees with price on information RSI cannot see.
 */
export function volumeProfile(c) {
  const name = 'volume_profile';
  const closes = c.map((x) => x.close), highs = c.map((x) => x.high),
    lows = c.map((x) => x.low), vols = c.map((x) => x.volume);
  if (closes.length < 80) return NONE(name, 'not enough candles');

  const WIN = 80;
  const BUCKETS = 20;
  const price = I.last(closes);
  const a = I.last(I.atr(highs, lows, closes, 14));
  if (!a) return NONE(name, 'indicators warming up');

  // --- point of control over the window
  const hMax = Math.max(...highs.slice(-WIN));
  const lMin = Math.min(...lows.slice(-WIN));
  const step = (hMax - lMin) / BUCKETS;
  if (!(step > 0)) return NONE(name, 'degenerate range');
  const buckets = new Array(BUCKETS).fill(0);
  for (let i = closes.length - WIN; i < closes.length; i++) {
    // assign the bar to the bucket its typical price falls in
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor((tp - lMin) / step)));
    buckets[b] += vols[i];
  }
  let pocIdx = 0;
  for (let i = 1; i < BUCKETS; i++) if (buckets[i] > buckets[pocIdx]) pocIdx = i;
  const poc = lMin + (pocIdx + 0.5) * step;

  // --- OBV and its divergence
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    obv[i] = obv[i - 1] + (closes[i] > closes[i - 1] ? vols[i] : closes[i] < closes[i - 1] ? -vols[i] : 0);
  }
  const obvSlopeNow = I.slope(obv.slice(-30), 30);
  const pxSlopeNow = I.slope(closes.slice(-30), 30);
  const obvSlopePrev = I.slope(obv.slice(-60, -30), 30);
  const pxSlopePrev = I.slope(closes.slice(-60, -30), 30);

  const distToPoc = (price - poc) / a;
  const notes = [
    `POC=${poc.toFixed(6)} (${distToPoc >= 0 ? '+' : ''}${distToPoc.toFixed(2)} ATR)`,
    `obvSlope=${obvSlopeNow.toFixed(2)} vs price ${pxSlopeNow.toFixed(2)}`,
  ];
  let side = null, conf = 0;

  // price and OBV pushing opposite ways over the last 30 bars
  const bearDiv = pxSlopeNow > 0.02 && obvSlopeNow < -0.02;
  const bullDiv = pxSlopeNow < -0.02 && obvSlopeNow > 0.02;

  if (bearDiv) {
    side = 'SHORT';
    conf = 54 + clamp(Math.abs(pxSlopeNow - obvSlopeNow) * 55, 0, 22);
    notes.push(`price up ${pxSlopeNow.toFixed(2)} while OBV falls ${obvSlopeNow.toFixed(2)} — distribution`);
  } else if (bullDiv) {
    side = 'LONG';
    conf = 54 + clamp(Math.abs(pxSlopeNow - obvSlopeNow) * 55, 0, 22);
    notes.push(`price down ${pxSlopeNow.toFixed(2)} while OBV rises ${obvSlopeNow.toFixed(2)} — accumulation`);
  } else if (distToPoc >= 0.9 && pxSlopeNow < 0) {
    // rejecting down from the point of control
    side = 'SHORT';
    conf = 50 + clamp(distToPoc * 8, 0, 20);
    notes.push('rejecting the point of control from above');
  } else if (distToPoc <= -0.9 && pxSlopeNow > 0) {
    side = 'LONG';
    conf = 50 + clamp(Math.abs(distToPoc) * 8, 0, 20);
    notes.push('rejecting the point of control from below');
  } else {
    return NONE(name, 'volume and price agree — no level or divergence');
  }

  // a divergence that was already present in the previous window has been
  // traded on already; only a FRESH one is an entry
  if ((bearDiv || bullDiv) && Math.sign(obvSlopePrev) === Math.sign(obvSlopeNow)
      && Math.abs(obvSlopePrev) > Math.abs(obvSlopeNow)) {
    conf -= 12; notes.push('divergence is weakening, not fresh');
  }
  return { name, side, confidence: clamp(conf), notes };
}

export const STRATEGIES = [
  { key: 'trend_supertrend', fn: trendSupertrend, family: 'trend' },
  { key: 'momentum_macd', fn: momentumMacd, family: 'momentum' },
  { key: 'squeeze_breakout', fn: squeezeBreakout, family: 'breakout' },
  { key: 'vwap_reversion', fn: vwapReversion, family: 'mean_reversion' },
  { key: 'ema_pullback', fn: emaPullback, family: 'trend' },
  { key: 'orderflow_funding', fn: orderflowFunding, family: 'flow' },
  { key: 'rsi_divergence', fn: rsiDivergence, family: 'reversal' },
  { key: 'bollinger_bounce', fn: bollingerBounce, family: 'mean_reversion' },
  { key: 'atr_channel_break', fn: atrChannelBreak, family: 'breakout' },
  { key: 'volume_profile', fn: volumeProfile, family: 'flow' },
];

/** How many strategies exist — never hardcode this in a message. */
export const STRATEGY_COUNT = STRATEGIES.length;

/**
 * Which strategies deserve trust in the current regime.
 * (regime-first selection, as recommended for crypto perps)
 */
export function regimeWeights(regimeName) {
  switch (regimeName) {
    case 'TREND_UP':
    case 'TREND_DOWN':
      return { trend_supertrend: 1.25, ema_pullback: 1.2, momentum_macd: 1.1,
        squeeze_breakout: 1.0, vwap_reversion: 0.5, orderflow_funding: 0.9,
        rsi_divergence: 0.5, bollinger_bounce: 0.45, atr_channel_break: 1.2,
        volume_profile: 0.9 };
    case 'RANGE':
      return { trend_supertrend: 0.7, ema_pullback: 0.7, momentum_macd: 0.85,
        squeeze_breakout: 0.9, vwap_reversion: 1.3, orderflow_funding: 1.1,
        rsi_divergence: 1.15, bollinger_bounce: 1.35, atr_channel_break: 0.55,
        volume_profile: 1.0 };
    case 'SQUEEZE':
      return { trend_supertrend: 0.8, ema_pullback: 0.8, momentum_macd: 1.0,
        squeeze_breakout: 1.35, vwap_reversion: 0.8, orderflow_funding: 1.0,
        rsi_divergence: 0.9, bollinger_bounce: 0.9, atr_channel_break: 1.3,
        volume_profile: 1.0 };
    case 'VOLATILE':
      return { trend_supertrend: 1.05, ema_pullback: 0.8, momentum_macd: 1.15,
        squeeze_breakout: 1.15, vwap_reversion: 0.6, orderflow_funding: 1.05,
        rsi_divergence: 0.7, bollinger_bounce: 0.5, atr_channel_break: 1.1,
        volume_profile: 1.15 };
    default:
      return {};
  }
}

/** Run all ten strategies on one timeframe. */
export function runAll(candles, ctx = {}) {
  return STRATEGIES.map(({ fn, key }) => {
    try { return fn(candles, ctx); }
    catch (e) { return { name: key, side: null, confidence: 0, notes: [`error: ${e.message}`] }; }
  });
}
