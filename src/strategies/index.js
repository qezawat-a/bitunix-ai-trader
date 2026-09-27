import * as I from './indicators.js';

/**
 * SIX strategies, chosen to cover every market regime a perpetual-futures
 * book can be in (research-backed classic families, adapted to crypto perps):
 *
 *  1. trend_supertrend   - trend following  (Supertrend + EMA200 + ADX)
 *  2. momentum_macd      - momentum         (MACD + RSI + volume expansion)
 *  3. squeeze_breakout   - volatility breakout (BB/KC squeeze + Donchian break)
 *  4. vwap_reversion     - mean reversion   (VWAP deviation + StochRSI exhaustion)
 *  5. ema_pullback       - trend pullback   (EMA20/50 stack + shallow retrace)
 *  6. orderflow_funding  - order-flow / carry (book imbalance + funding skew)
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
  const fr = Number(funding?.fundingRate ?? 0);                 // e.g. 0.0005
  const sl = I.slope(closes, 20);
  const notes = [`imbalance=${(imb * 100).toFixed(1)}%`, `funding=${(fr * 100).toFixed(4)}%`, `slope=${sl.toFixed(3)}`];

  let side = null, conf = 0;
  // Crowded longs (very positive funding) + selling book pressure -> fade to SHORT.
  // Crowded shorts (very negative funding) + buying book pressure -> fade to LONG.
  const crowdedLong = fr > 0.0006;
  const crowdedShort = fr < -0.0006;

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

export const STRATEGIES = [
  { key: 'trend_supertrend', fn: trendSupertrend, family: 'trend' },
  { key: 'momentum_macd', fn: momentumMacd, family: 'momentum' },
  { key: 'squeeze_breakout', fn: squeezeBreakout, family: 'breakout' },
  { key: 'vwap_reversion', fn: vwapReversion, family: 'mean_reversion' },
  { key: 'ema_pullback', fn: emaPullback, family: 'trend' },
  { key: 'orderflow_funding', fn: orderflowFunding, family: 'flow' },
];

/**
 * Which strategies deserve trust in the current regime.
 * (regime-first selection, as recommended for crypto perps)
 */
export function regimeWeights(regimeName) {
  switch (regimeName) {
    case 'TREND_UP':
    case 'TREND_DOWN':
      return { trend_supertrend: 1.25, ema_pullback: 1.2, momentum_macd: 1.1,
        squeeze_breakout: 1.0, vwap_reversion: 0.5, orderflow_funding: 0.9 };
    case 'RANGE':
      return { trend_supertrend: 0.7, ema_pullback: 0.7, momentum_macd: 0.85,
        squeeze_breakout: 0.9, vwap_reversion: 1.3, orderflow_funding: 1.1 };
    case 'SQUEEZE':
      return { trend_supertrend: 0.8, ema_pullback: 0.8, momentum_macd: 1.0,
        squeeze_breakout: 1.35, vwap_reversion: 0.8, orderflow_funding: 1.0 };
    case 'VOLATILE':
      return { trend_supertrend: 1.05, ema_pullback: 0.8, momentum_macd: 1.15,
        squeeze_breakout: 1.15, vwap_reversion: 0.6, orderflow_funding: 1.05 };
    default:
      return {};
  }
}

/** Run all six strategies on one timeframe. */
export function runAll(candles, ctx = {}) {
  return STRATEGIES.map(({ fn, key }) => {
    try { return fn(candles, ctx); }
    catch (e) { return { name: key, side: null, confidence: 0, notes: [`error: ${e.message}`] }; }
  });
}
