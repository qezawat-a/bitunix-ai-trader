import bitunix from '../exchange/bitunix.js';
import { createLogger } from '../logger.js';
import * as I from '../strategies/indicators.js';
import { runAll, regimeWeights, STRATEGIES } from '../strategies/index.js';
import { settings, strategyWeights, saveSignal, isCoolingDown, signalStreak } from '../db/index.js';

const log = createLogger('scanner');

const klineCache = new Map();  // `${symbol}:${tf}` -> {at, candles}
const KLINE_TTL = 10_000;

function normaliseKlines(raw) {
  return (raw || [])
    .map((k) => ({
      time: Number(k.time ?? k.ts ?? 0),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.baseVol ?? k.volume ?? 0),
      quoteVol: Number(k.quoteVol ?? 0),
    }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

const TF_MINUTES = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '6h': 360, '8h': 480, '12h': 720,
  '1d': 1440, '3d': 4320, '1w': 10080, '1M': 43200,
};

/**
 * The official SDK's KlineInterval enum carries a second spelling for some
 * intervals ("1min", "60min", "1day", "1week", "1month"). Probing the endpoint
 * shows every long form is accepted, including "3min" — which the enum does
 * not list, exactly as it omits "3m". Both spellings hit the same series, so
 * they are normalised to the short form here rather than rejected: a user
 * copying an interval out of the SDK should not get an error.
 */
const TF_ALIASES = {
  '1min': '1m', '3min': '3m', '5min': '5m', '15min': '15m', '30min': '30m',
  '60min': '1h', '1hour': '1h', '1day': '1d', '3day': '3d',
  '1week': '1w', '1month': '1M',
};

/** Normalise an interval to its canonical short form. Unknown input is returned as-is. */
export function normaliseTimeframe(tf) {
  const t = String(tf || '').trim();
  if (TF_MINUTES[t]) return t;
  const lower = t.toLowerCase();
  if (TF_ALIASES[lower]) return TF_ALIASES[lower];
  // '1M' (month) vs '1m' (minute) is the one case where case matters
  const exact = Object.keys(TF_MINUTES).find((k) => k.toLowerCase() === lower);
  return exact && lower !== '1m' ? exact : t;
}

/**
 * Candles with pagination.
 * The Bitunix kline endpoint caps `limit` at 200, but EMA200 / Supertrend need
 * more history than that to be valid, so we walk backwards with `endTime`
 * until we have `limit` bars (or the exchange runs out).
 */
export async function getCandles(symbol, interval, limit = 400) {
  const key = `${symbol}:${interval}:${limit}`;
  const hit = klineCache.get(key);
  if (hit && Date.now() - hit.at < KLINE_TTL) return hit.candles;

  interval = normaliseTimeframe(interval);
  if (!TF_MINUTES[interval]) {
    // The exchange answers an unsupported interval with code 0 and an empty
    // array, so a typo would look like "no history" forever. Fail loudly.
    throw new Error(`unsupported interval "${interval}". Valid: ${Object.keys(TF_MINUTES).join(' ')}`);
  }

  const PAGE = 200;
  let all = normaliseKlines(await bitunix.getKline({ symbol, interval, limit: Math.min(PAGE, limit) }));

  let guard = 0;
  while (all.length < limit && guard++ < 4) {
    const oldest = all[0]?.time;
    if (!oldest) break;
    const page = normaliseKlines(await bitunix.getKline({
      symbol, interval, limit: PAGE, endTime: oldest - 1,
    }));
    if (!page.length) break;
    const seen = new Set(all.map((c) => c.time));
    const merged = page.filter((c) => !seen.has(c.time)).concat(all);
    if (merged.length === all.length) break;
    all = merged.sort((a, b) => a.time - b.time);
  }

  let candles = all.slice(-limit);

  // Bitunix drops bars from large pages. Measured across BTC/ETH/SOL/DOGE on
  // 5m and 15m: a 200-row page requested WITHOUT endTime is always complete,
  // while the paged-back request always came back exactly one bar short — and
  // re-asking for the same window with limit 50 returns the missing bar 7
  // times out of 8. So most of these holes are an artefact of the page size,
  // not absent history, and they are repairable.
  //
  // This matters beyond tidiness: a missing bar shifts every EMA/ATR/ADX
  // period after it, so the indicators were quietly reading slightly wrong
  // series on every symbol.
  // re-slice: a repair can push the series one bar over the requested length
  candles = (await backfillGaps(symbol, interval, candles)).slice(-limit);

  // Whatever survives the backfill is genuine missing history (an exchange
  // outage). Report it once per shape rather than on every scan pass.
  const gaps = countGaps(candles, interval);
  if (gaps.missing > 0) reportGaps(symbol, interval, candles.length, gaps);

  klineCache.set(key, { at: Date.now(), candles });
  return candles;
}


/** How many bars are missing from an otherwise contiguous series. */
/**
 * Re-fetch the windows around any holes with a small page size and merge back
 * whatever the exchange returns that time.
 *
 * Capped at MAX_REPAIRS windows per call so a badly broken series costs a
 * bounded number of extra requests rather than hammering the endpoint.
 */
let repairCount = 0;   // bars recovered this process, surfaced by /status
export function klineRepairCount() { return repairCount; }

const REPAIR_PAGE = 50;
const MAX_REPAIRS = 4;

async function backfillGaps(symbol, interval, candles) {
  const step = (TF_MINUTES[interval] || 0) * 60_000;
  if (!step || candles.length < 2) return candles;

  const holes = [];
  for (let i = 1; i < candles.length; i++) {
    if (Math.round((candles[i].time - candles[i - 1].time) / step) > 1) {
      holes.push({ after: candles[i - 1].time, before: candles[i].time });
    }
  }
  if (!holes.length) return candles;

  const byTime = new Map(candles.map((c) => [c.time, c]));
  let recovered = 0;
  for (const hole of holes.slice(0, MAX_REPAIRS)) {
    try {
      const page = normaliseKlines(await bitunix.getKline({
        symbol, interval, limit: REPAIR_PAGE, endTime: hole.before - 1,
      }));
      for (const c of page) {
        if (c.time > hole.after && c.time < hole.before && !byTime.has(c.time)) {
          byTime.set(c.time, c);
          recovered++;
        }
      }
    } catch {
      // a failed repair just leaves the hole; never let this break a scan
    }
  }
  if (!recovered) return candles;

  repairCount += recovered;
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * De-duplicated gap reporting.
 *
 * Keyed on the gap's shape, not the time it was seen, so a stable historical
 * hole is announced once and a NEW or worsening one still gets through.
 */
const gapSeen = new Map();          // symbol|interval -> fingerprint
const GAP_RENOTIFY_MS = 6 * 60 * 60 * 1000;

function reportGaps(symbol, interval, length, gaps) {
  const key = `${symbol}|${interval}`;
  const fingerprint = `${gaps.missing}:${gaps.worst}`;
  const prev = gapSeen.get(key);
  if (prev && prev.fingerprint === fingerprint && Date.now() - prev.at < GAP_RENOTIFY_MS) return;
  gapSeen.set(key, { fingerprint, at: Date.now() });

  const pct = (gaps.missing / length) * 100;
  const msg = `${symbol} ${interval}: ${gaps.missing} missing bar(s) in ${length}`
    + ` (${pct.toFixed(2)}%, worst gap ${gaps.worst}x)`;

  // A single isolated bar is a blemish; a wide hole distorts every indicator.
  if (gaps.worst >= 3 || pct >= 2) log.warn(`${msg} — indicators on this series are unreliable`);
  else log.info(`${msg} — negligible, noted once`);
}

/** Forget what has been reported (used by tests and on a universe change). */
export function resetGapReports() { gapSeen.clear(); }

function countGaps(candles, interval) {
  const step = (TF_MINUTES[interval] || 0) * 60_000;
  if (!step || candles.length < 2) return { missing: 0, worst: 1 };
  let missing = 0, worst = 1;
  for (let i = 1; i < candles.length; i++) {
    const n = Math.round((candles[i].time - candles[i - 1].time) / step);
    if (n > 1) { missing += n - 1; worst = Math.max(worst, n); }
  }
  return { missing, worst };
}

/** Timeframes the exchange accepts, shortest first. */
export const SUPPORTED_TIMEFRAMES = Object.keys(TF_MINUTES);

/** Minutes per timeframe, for callers that need to reason about horizon. */
export function timeframeMinutes(tf) { return TF_MINUTES[tf] || null; }

/**
 * Build the trading universe.
 * settings.symbols === 'AUTO'  -> pull EVERY tradable pair from the exchange
 *                                 (get_trading_pairs + get_tickers) and rank by
 *                                 24h quote volume * |range|, keep universe_size.
 * otherwise                    -> honour the explicit comma-separated list.
 */
export async function buildUniverse() {
  const s = settings();
  const raw = String(s.symbols || 'AUTO').trim();

  const pairs = await bitunix.getTradingPairs();
  const tradable = (pairs || []).filter(
    (p) => p.symbolStatus === 'OPEN' && p.isApiSupported !== false && p.quote === 'USDT',
  );
  const tradableSet = new Set(tradable.map((p) => p.symbol));

  if (raw.toUpperCase() !== 'AUTO') {
    const wanted = raw.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    return wanted.filter((x) => tradableSet.has(x));
  }

  const tickers = await bitunix.getTickers();

  // Liquidity floor. Below this, leveraged entries pay the spread twice and a
  // stop can be swept by a single order — no amount of "movement" makes a
  // $500k book worth trading. Configurable via min_24h_volume_usd.
  const minVol = Number(s.min_24h_volume_usd ?? 20_000_000);

  const candidates = (tickers || [])
    .filter((t) => tradableSet.has(t.symbol))
    .map((t) => {
      const lastP = Number(t.lastPrice || t.last || 0);
      const high = Number(t.high || 0), low = Number(t.low || 0);
      const range = low > 0 ? (high - low) / low : 0;
      const qv = Number(t.quoteVol || 0);
      // 24h change from the ticker's own open, the same basis the exchange
      // shows on its market page
      const open = Number(t.open || 0);
      const chg = open > 0 ? ((lastP - open) / open) * 100 : 0;
      return { symbol: t.symbol, qv, range, price: lastP, chg };
    })
    .filter((x) => x.qv > 0 && x.price > 0);

  let pool = candidates.filter((x) => x.qv >= minVol);

  // If the floor is set so high that almost nothing passes, fall back to the
  // most liquid names rather than returning an empty universe.
  if (pool.length < 10) {
    pool = candidates.sort((a, b) => b.qv - a.qv).slice(0, Math.max(10, Number(s.universe_size || 40)));
    log.warn(`min_24h_volume_usd=${minVol} left only ${pool.length} pairs — falling back to the most liquid ones`);
  }

  // Rank the survivors. Liquidity dominates; volatility is a tie-breaker, not
  // a multiplier that can lift an illiquid coin above BTC.
  //
  // Previously this was log10(volume) * (1 + range*4), which compressed a
  // 2000x volume difference into 1.5x of score and then let a 70% daily range
  // erase it — BTC ($2.4B) ranked 64th, behind coins doing $600k. That is how
  // you end up long a microcap with 10x leverage.
  // How to rank what survives the liquidity floor.
  //
  //   VOLUME   the deepest books first, movement only as a tie-breaker
  //   GAINERS  biggest 24h gain first — momentum, and long-biased by nature
  //   LOSERS   biggest 24h fall first — the short side of the same idea
  //   MOVERS   biggest move in either direction
  //
  // min_24h_volume_usd still applies in every mode, and it matters MORE in the
  // change-ranked modes: the biggest movers on an exchange are usually the
  // thinnest books, which is exactly where a stop gets swept. The floor is the
  // only thing keeping those out.
  const mode = String(s.universe_rank || 'VOLUME').toUpperCase();
  const maxVol = Math.max(...pool.map((x) => x.qv));

  let scored;
  if (mode === 'GAINERS') {
    scored = [...pool].sort((a, b) => b.chg - a.chg);
  } else if (mode === 'LOSERS') {
    scored = [...pool].sort((a, b) => a.chg - b.chg);
  } else if (mode === 'MOVERS') {
    scored = [...pool].sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
  } else {
    scored = pool
      .map((x) => {
        const liquidity = x.qv / maxVol;                  // 0..1, linear
        const movement = Math.min(x.range, 0.25) / 0.25;  // 0..1, capped at 25%
        return { ...x, score: liquidity * 0.75 + movement * 0.25 };
      })
      .sort((a, b) => b.score - a.score);
  }

  const size = Number(s.universe_size || 40);
  const picked = scored.slice(0, size);
  if (picked.length) {
    const head = picked.slice(0, 5)
      .map((x) => `${x.symbol} ${x.chg >= 0 ? '+' : ''}${x.chg.toFixed(1)}%`).join(', ');
    log.info(`universe by ${mode}: ${picked.length} pairs — ${head}`);
  }
  return picked.map((x) => x.symbol);
}

/** Analyse one symbol across all configured timeframes. */
export async function analyseSymbol(symbol) {
  const s = settings();
  const tfs = String(s.timeframes || '5m,15m,1h').split(',').map((x) => x.trim()).filter(Boolean);

  // live context for the order-flow strategy
  let depth = null, funding = null;
  try { depth = await bitunix.getDepth(symbol, 15); } catch {}
  try { funding = await bitunix.getFundingRate(symbol); } catch {}

  const perTf = {};
  let baseRegime = null, baseAtr = null, price = null;

  for (const tf of tfs) {
    let candles;
    try { candles = await getCandles(symbol, tf, 400); }
    catch (e) { perTf[tf] = { error: e.message }; continue; }
    if (candles.length < 60) { perTf[tf] = { error: 'insufficient history' }; continue; }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const reg = I.regime(candles);
    const a = I.last(I.atr(highs, lows, closes, 14));
    const results = runAll(candles, { depth, funding });

    perTf[tf] = {
      regime: reg.regime,
      adx: Number(reg.adx?.toFixed?.(1) ?? 0),
      atr: a,
      atrPct: (a / I.last(closes)) * 100,
      price: I.last(closes),
      results,
    };

    // the *first* (lowest) timeframe is the execution timeframe
    if (!baseRegime) { baseRegime = reg.regime; baseAtr = a; price = I.last(closes); }
  }

  return { symbol, timeframes: perTf, regime: baseRegime, atr: baseAtr, price, depth, funding };
}

/**
 * Turn a multi-timeframe analysis into a consensus signal.
 *
 *  - a strategy "votes" on a timeframe only when its confidence >= tf_min_confidence
 *  - agreement = number of DISTINCT strategies voting the same side (>= min_agreement)
 *  - confidence = weighted average (live performance weight x regime weight x tf weight)
 *  - higher timeframes act as a veto: if the top TF trend is clearly opposite, penalise
 */
export async function consensus(analysis) {
  const s = settings();
  const tfMin = Number(s.tf_min_confidence || 60);
  const { map: perfWeights } = await strategyWeights();
  const regW = regimeWeights(analysis.regime);

  const tfKeys = Object.keys(analysis.timeframes).filter((k) => !analysis.timeframes[k].error);
  if (!tfKeys.length) return null;

  // longer timeframe = more weight
  const tfWeight = {};
  tfKeys.forEach((tf, idx) => { tfWeight[tf] = 1 + idx * 0.35; });

  const votes = { LONG: new Map(), SHORT: new Map() };
  const detail = [];

  for (const tf of tfKeys) {
    const block = analysis.timeframes[tf];
    for (const r of block.results) {
      if (!r.side || r.confidence < tfMin) continue;
      const w = (perfWeights[r.name] ?? 1) * (regW[r.name] ?? 1) * tfWeight[tf];
      const bucket = votes[r.side];
      const cur = bucket.get(r.name) || { sum: 0, wsum: 0, tfs: [], notes: [] };
      cur.sum += r.confidence * w;
      cur.wsum += w;
      cur.tfs.push(tf);
      cur.notes.push(...r.notes);
      bucket.set(r.name, cur);
      detail.push({ tf, strategy: r.name, side: r.side, confidence: Math.round(r.confidence), weight: Number(w.toFixed(2)) });
    }
  }

  const scoreSide = (side) => {
    const m = votes[side];
    if (!m.size) return { side, agreement: 0, confidence: 0, strategies: [] };
    let sum = 0, wsum = 0;
    const strategies = [];
    for (const [name, v] of m) {
      sum += v.sum; wsum += v.wsum;
      strategies.push({
        name,
        confidence: Math.round(v.sum / v.wsum),
        timeframes: [...new Set(v.tfs)],
        notes: [...new Set(v.notes)].slice(0, 3),
      });
    }
    return { side, agreement: m.size, confidence: wsum ? sum / wsum : 0, strategies };
  };

  const longScore = scoreSide('LONG');
  const shortScore = scoreSide('SHORT');
  let best = longScore.agreement * longScore.confidence >= shortScore.agreement * shortScore.confidence
    ? longScore : shortScore;
  if (!best.agreement) return null;

  // --- higher-timeframe veto -------------------------------------------
  const topTf = tfKeys[tfKeys.length - 1];
  const topRegime = analysis.timeframes[topTf].regime;
  let conf = best.confidence;
  const flags = [];
  if (best.side === 'LONG' && topRegime === 'TREND_DOWN') { conf -= 18; flags.push(`HTF ${topTf} is TREND_DOWN`); }
  if (best.side === 'SHORT' && topRegime === 'TREND_UP') { conf -= 18; flags.push(`HTF ${topTf} is TREND_UP`); }

  // conflict penalty: both sides voting
  const opposite = best.side === 'LONG' ? shortScore : longScore;
  if (opposite.agreement >= 2) { conf -= 10; flags.push(`${opposite.agreement} strategies vote ${opposite.side}`); }

  return {
    symbol: analysis.symbol,
    side: best.side,
    confidence: Math.max(0, Math.min(100, Math.round(conf))),
    rawConfidence: Math.round(best.confidence),
    agreement: best.agreement,
    strategies: best.strategies,
    opposite: { side: opposite.side, agreement: opposite.agreement, confidence: Math.round(opposite.confidence) },
    detail,
    flags,
    regime: analysis.regime,
    htfRegime: topRegime,
    price: analysis.price,
    atr: analysis.atr,
    atrPct: analysis.atr && analysis.price ? (analysis.atr / analysis.price) * 100 : null,
    funding: analysis.funding?.fundingRate != null ? Number(analysis.funding.fundingRate) : null,
    timeframes: Object.fromEntries(
      tfKeys.map((tf) => [tf, {
        regime: analysis.timeframes[tf].regime,
        adx: analysis.timeframes[tf].adx,
        atrPct: Number(analysis.timeframes[tf].atrPct?.toFixed(3)),
      }]),
    ),
  };
}

/** Full scan pass over the universe. Returns candidate signals sorted by quality. */
export async function scan({ onlySymbols = null, persist = true } = {}) {
  const s = settings();
  const universe = onlySymbols || await buildUniverse();
  const minAgree = Number(s.min_agreement || 2);
  const minConf = Number(s.min_confidence || 80);
  const confirmScans = Number(s.signal_confirm_scans || 1);
  const cooldown = Number(s.cooldown_min || 5);

  const out = [];
  const CONCURRENCY = 4;

  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const chunk = universe.slice(i, i + CONCURRENCY);
    const analyses = await Promise.all(chunk.map(async (sym) => {
      try { return await analyseSymbol(sym); }
      catch (e) { log.debug(`${sym}: ${e.message}`); return null; }
    }));

    for (const a of analyses) {
      if (!a) continue;
      const sig = await consensus(a);
      if (!sig) continue;

      let rejectReason = null;
      if (sig.agreement < minAgree) rejectReason = `agreement ${sig.agreement} < ${minAgree}`;
      else if (sig.confidence < minConf) rejectReason = `confidence ${sig.confidence} < ${minConf}`;
      else {
        const cd = await isCoolingDown(sig.symbol);
        if (cd) rejectReason = `cooldown until ${new Date(cd).toISOString().slice(11, 19)}`;
      }

      if (!rejectReason && confirmScans > 1) {
        const streak = await signalStreak(sig.symbol, sig.side, Math.max(2, cooldown));
        if (streak + 1 < confirmScans) rejectReason = `needs ${confirmScans} confirming scans (have ${streak + 1})`;
      }

      sig.rejectReason = rejectReason;
      sig.qualified = !rejectReason;

      if (persist) {
        sig.dbId = await saveSignal({
          symbol: sig.symbol, side: sig.side, confidence: sig.confidence, agreement: sig.agreement,
          strategies: sig.strategies.map((x) => x.name), timeframes: sig.timeframes,
          price: sig.price, atr: sig.atr, atrPct: sig.atrPct, regime: sig.regime,
          taken: false, rejectReason,
        });
      }
      out.push(sig);
    }
  }

  out.sort((a, b) => (b.qualified - a.qualified)
    || (b.agreement * b.confidence) - (a.agreement * a.confidence));
  return out;
}

export const STRATEGY_KEYS = STRATEGIES.map((x) => x.key);
