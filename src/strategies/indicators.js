/**
 * Dependency-free technical indicator library.
 * All functions take/return plain arrays of numbers, oldest -> newest.
 */

export const last = (a) => (a && a.length ? a[a.length - 1] : null);
export const prev = (a, n = 1) => (a && a.length > n ? a[a.length - 1 - n] : null);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let e = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      let s = 0; for (let j = 0; j < period; j++) s += values[j];
      e = s / period; out[i] = e;
    } else if (i >= period) {
      e = values[i] * k + e * (1 - k); out[i] = e;
    }
  }
  return out;
}

/** Wilder's smoothing (used by RSI / ATR / ADX) */
export function rma(values, period) {
  const out = new Array(values.length).fill(null);
  let acc = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      let s = 0; for (let j = 0; j < period; j++) s += values[j];
      acc = s / period; out[i] = acc;
    } else if (i >= period) {
      acc = (acc * (period - 1) + values[i]) / period; out[i] = acc;
    }
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += values[j];
    m /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

export function rsi(closes, period = 14) {
  const gains = [0], losses = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = rma(gains, period), al = rma(losses, period);
  return closes.map((_, i) => {
    if (ag[i] == null || al[i] == null) return null;
    if (al[i] === 0) return 100;
    const rs = ag[i] / al[i];
    return 100 - 100 / (1 + rs);
  });
}

export function trueRange(highs, lows, closes) {
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  return tr;
}

export function atr(highs, lows, closes, period = 14) {
  return rma(trueRange(highs, lows, closes), period);
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const compact = line.filter((v) => v != null);
  const sigCompact = ema(compact, signal);
  const sig = new Array(line.length).fill(null);
  let k = 0;
  for (let i = 0; i < line.length; i++) if (line[i] != null) sig[i] = sigCompact[k++];
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period), sd = stdev(closes, period);
  return {
    mid,
    upper: mid.map((m, i) => (m != null && sd[i] != null ? m + mult * sd[i] : null)),
    lower: mid.map((m, i) => (m != null && sd[i] != null ? m - mult * sd[i] : null)),
    width: mid.map((m, i) => (m != null && sd[i] != null && m !== 0 ? (2 * mult * sd[i]) / m : null)),
  };
}

export function keltner(highs, lows, closes, period = 20, mult = 1.5) {
  const mid = ema(closes, period);
  const a = atr(highs, lows, closes, period);
  return {
    mid,
    upper: mid.map((m, i) => (m != null && a[i] != null ? m + mult * a[i] : null)),
    lower: mid.map((m, i) => (m != null && a[i] != null ? m - mult * a[i] : null)),
  };
}

export function adx(highs, lows, closes, period = 14) {
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < highs.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = rma(trueRange(highs, lows, closes), period);
  const pdm = rma(plusDM, period), mdm = rma(minusDM, period);
  const pdi = tr.map((t, i) => (t && pdm[i] != null ? (100 * pdm[i]) / t : null));
  const mdi = tr.map((t, i) => (t && mdm[i] != null ? (100 * mdm[i]) / t : null));
  const dx = pdi.map((p, i) => (p != null && mdi[i] != null && p + mdi[i] !== 0
    ? (100 * Math.abs(p - mdi[i])) / (p + mdi[i]) : null));
  const compact = dx.filter((v) => v != null);
  const adxCompact = rma(compact, period);
  const out = new Array(dx.length).fill(null);
  let k = 0;
  for (let i = 0; i < dx.length; i++) if (dx[i] != null) out[i] = adxCompact[k++];
  return { adx: out, pdi, mdi };
}

export function supertrend(highs, lows, closes, period = 10, mult = 3) {
  const a = atr(highs, lows, closes, period);
  const dir = new Array(closes.length).fill(null);
  const line = new Array(closes.length).fill(null);
  let upper = null, lower = null, trend = 1;
  for (let i = 0; i < closes.length; i++) {
    if (a[i] == null) continue;
    const mid = (highs[i] + lows[i]) / 2;
    let up = mid + mult * a[i];
    let lo = mid - mult * a[i];
    if (upper != null) up = closes[i - 1] > upper ? Math.max(up, upper) : up;
    if (lower != null) lo = closes[i - 1] < lower ? Math.min(lo, lower) : lo;
    if (upper != null) trend = closes[i] > upper ? 1 : closes[i] < lower ? -1 : trend;
    upper = up; lower = lo;
    dir[i] = trend;
    line[i] = trend === 1 ? lower : upper;
  }
  return { dir, line };
}

export function vwap(highs, lows, closes, volumes) {
  // rolling session-less VWAP over the provided window
  const out = new Array(closes.length).fill(null);
  let pv = 0, vv = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    pv += tp * volumes[i]; vv += volumes[i];
    out[i] = vv ? pv / vv : null;
  }
  return out;
}

export function donchian(highs, lows, period = 20) {
  const upper = new Array(highs.length).fill(null);
  const lower = new Array(lows.length).fill(null);
  for (let i = period - 1; i < highs.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, highs[j]); lo = Math.min(lo, lows[j]); }
    upper[i] = hi; lower[i] = lo;
  }
  return { upper, lower };
}

export function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14, k = 3, d = 3) {
  const r = rsi(closes, rsiPeriod);
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < rsiPeriod + stochPeriod) continue;
    const win = r.slice(i - stochPeriod + 1, i + 1).filter((v) => v != null);
    if (win.length < stochPeriod) continue;
    const hi = Math.max(...win), lo = Math.min(...win);
    out[i] = hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
  }
  const kLine = sma(out.map((v) => (v == null ? 0 : v)), k);
  const dLine = sma(kLine.map((v) => (v == null ? 0 : v)), d);
  return { stoch: out, k: kLine, d: dLine };
}

/** Linear-regression slope of the last `period` points, normalised by price. */
export function slope(values, period = 20) {
  const v = values.slice(-period).filter((x) => x != null);
  const n = v.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += v[i]; sxy += i * v[i]; sxx += i * i; }
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const mean = sy / n;
  return mean ? (m / mean) * 100 : 0;
}

/** Volume z-score of the most recent bar. */
export function volumeZ(volumes, period = 20) {
  const v = volumes.slice(-period);
  if (v.length < period) return 0;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return sd ? (volumes[volumes.length - 1] - mean) / sd : 0;
}

/**
 * Market regime classification, used by the agent to pick which strategies to trust.
 * TREND_UP / TREND_DOWN / RANGE / SQUEEZE / VOLATILE
 */
export function regime(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const { adx: adxArr } = adx(highs, lows, closes, 14);
  const a = last(adxArr) ?? 0;
  const bb = bollinger(closes, 20, 2);
  const kc = keltner(highs, lows, closes, 20, 1.5);
  const squeeze = last(bb.upper) != null && last(kc.upper) != null
    && last(bb.upper) < last(kc.upper) && last(bb.lower) > last(kc.lower);
  const atrPct = (last(atr(highs, lows, closes, 14)) / last(closes)) * 100;
  const sl = slope(ema(closes, 50), 20);

  if (squeeze) return { regime: 'SQUEEZE', adx: a, atrPct, slope: sl };
  if (atrPct > 3) return { regime: 'VOLATILE', adx: a, atrPct, slope: sl };
  if (a >= 22 && sl > 0.05) return { regime: 'TREND_UP', adx: a, atrPct, slope: sl };
  if (a >= 22 && sl < -0.05) return { regime: 'TREND_DOWN', adx: a, atrPct, slope: sl };
  return { regime: 'RANGE', adx: a, atrPct, slope: sl };
}
