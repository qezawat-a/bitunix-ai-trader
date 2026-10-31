/**
 * Bitunix Trading Analysis Agent
 *
 * Implements the full 5-phase trading-analysis pipeline adapted for Bitunix
 * USDT-M perpetual futures, using only the exchange's official REST endpoints.
 *
 * Phase 1 (parallel): Technical / News-Sentiment / Fundamentals / Macro analysts
 * Phase 2 (sequential): Bull analyst → Bear analyst → Risk analyst
 * Phase 3: Research Manager → investment plan
 * Phase 4: Trader → transaction proposal (entry / stop / size)
 * Phase 5: Portfolio Manager → final BUY / SELL / HOLD decision
 *
 * Market data comes from Bitunix endpoints:
 *   GET /api/v1/futures/market/tickers        -> price, 24h change, volume
 *   GET /api/v1/futures/market/kline          -> OHLCV candles
 *   GET /api/v1/futures/market/depth          -> order book (support/resistance)
 *   GET /api/v1/futures/market/funding_rate   -> current funding
 *   GET /api/v1/futures/market/funding_rate/history -> funding history
 *   GET /api/v1/futures/market/trading_pairs  -> contract specs
 *   GET /api/v1/futures/position/get_position_tiers -> leverage tiers
 *
 * Crypto futures have no P/E / balance-sheet fundamentals, so the Fundamentals
 * analyst substitutes: funding rate (cost of carry / crowded positioning),
 * 24h volume, max leverage from position tiers, and pair specifications.
 */

import bitunix from '../exchange/bitunix.js';
import ai from './providers.js';
import { createLogger } from '../logger.js';
import * as I from '../strategies/indicators.js';
import * as db from '../db/index.js';

const log = createLogger('analysis-agent');

const TODAY = new Date().toISOString().slice(0, 10);

// --------------------------------------------------------------- market data

/**
 * Fetch 200 candles for a symbol at 1h interval (primary timeframe for the
 * analysis agent), normalised into {time, open, high, low, close, volume}.
 */
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

/** Call the AI, retrying up to 3 times if it returns empty content. */
async function chatNonEmpty(opts, phase) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await ai.chat(opts);
      const content = String(r?.content ?? '').trim();
      if (!content) throw new Error('empty response');
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < 3 && String(e.message).includes('empty response')) continue;
      throw e;
    }
  }
  throw new Error(`${phase}: AI returned an empty response after 3 attempts`);
}

async function fetchKlines(symbol, interval = '1h', limit = 200) {
  const raw = await bitunix.getKline({ symbol, interval, limit, type: 'LAST_PRICE' });
  return normaliseKlines(raw);
}

/** Fetch a ticker snapshot for one symbol. */
async function fetchTicker(symbol) {
  const t = await bitunix.getTickers(symbol);
  return Array.isArray(t) ? t[0] : t;
}

/** Fetch order book depth for support/resistance levels. */
async function fetchDepth(symbol) {
  return bitunix.getDepth(symbol, '50');
}

/** Fetch current funding rate. */
async function fetchFunding(symbol) {
  return bitunix.getFundingRate(symbol);
}

/** Fetch funding rate history (crowded positioning signal). */
async function fetchFundingHistory(symbol, limit = 30) {
  return bitunix.getFundingRateHistory({ symbol, limit });
}

/** Fetch contract specs (tick size, min qty, leverage limits). */
async function fetchPairSpecs(symbol) {
  return bitunix.getTradingPairs(symbol);
}

/** Fetch position tiers (max leverage per notional bracket). */
async function fetchPositionTiers(symbol) {
  return bitunix.getPositionTiers({ symbol });
}

// --------------------------------------------------------------- indicators

function series(candles, field) { return candles.map((c) => c[field]); }

function computeTechnicals(candles) {
  const closes = series(candles, 'close');
  const highs = series(candles, 'high');
  const lows = series(candles, 'low');
  const volumes = series(candles, 'volume');

  const ema10 = I.ema(closes, 10);
  const sma50 = I.sma(closes, 50);
  const sma200 = I.sma(closes, 200);
  const rsi14 = I.rsi(closes, 14);
  const macd = I.macd(closes, 12, 26, 9);
  const atr14 = I.atr(highs, lows, closes, 14);
  const bb = I.bollinger(closes, 20, 2);

  const lastIdx = closes.length - 1;
  const price = closes[lastIdx];
  const atrVal = atr14[lastIdx];
  const atrPct = price ? (atrVal / price) * 100 : 0;

  // Support/resistance from recent swing lows/highs + Bollinger bands
  const lookback = 20;
  const recentCloses = closes.slice(-lookback);
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const nearestSupport = Math.min(...recentLows.filter((v) => v != null));
  const nearestResistance = Math.max(...recentHighs.filter((v) => v != null));
  const bbLower = bb.lower[lastIdx];
  const bbUpper = bb.upper[lastIdx];
  const bbMid = bb.mid[lastIdx];

  // MACD direction: histogram slope over last 3 bars
  const hist = macd.hist;
  const histValid = hist.filter((v) => v != null);
  const macdDirection = histValid.length >= 3
    ? histValid[histValid.length - 1] > histValid[histValid.length - 2]
      ? 'rising'
      : histValid[histValid.length - 1] < histValid[histValid.length - 2]
        ? 'falling'
        : 'flat'
    : 'flat';

  return {
    price,
    ema10: ema10[lastIdx],
    sma50: sma50[lastIdx],
    sma200: sma200[lastIdx],
    rsi: rsi14[lastIdx],
    macdLine: macd.line[lastIdx],
    macdSignal: macd.signal[lastIdx],
    macdHist: macd.hist[lastIdx],
    macdDirection,
    atr: atrVal,
    atrPct,
    bbUpper, bbMid, bbLower,
    nearestSupport, nearestResistance,
    trend: price > (ema10[lastIdx] ?? 0) ? 'bullish' : price < (ema10[lastIdx] ?? 0) ? 'bearish' : 'neutral',
    structure: (sma50[lastIdx] ?? 0) > (sma200[lastIdx] ?? 0) ? 'bullish_stack' : (sma50[lastIdx] ?? 0) < (sma200[lastIdx] ?? 0) ? 'bearish_stack' : 'mixed',
  };
}

// --------------------------------------------------------------- Phase 1 analysts

/**
 * Subagent 1 — Technical Analyst (Bitunix).
 * Uses getKline (1h, 200 bars), getDepth, getTickers.
 */
async function technicalAnalyst(symbol) {
  const candles = await fetchKlines(symbol, '1h', 200);
  const depth = await fetchDepth(symbol);
  const ticker = await fetchTicker(symbol);
  const tech = computeTechnicals(candles);

  const bid = depth?.bids?.[0]?.[0] ?? tech.price;
  const ask = depth?.asks?.[0]?.[0] ?? tech.price;
  const spread = bid && ask ? ((ask - bid) / bid) * 100 : 0;

  const rsi = tech.rsi ?? 50;
  let momentum = 'neutral';
  if (rsi > 60) momentum = 'bullish';
  else if (rsi < 40) momentum = 'bearish';

  const macdBullish = tech.macdHist > 0 && tech.macdDirection === 'rising';
  const macdBearish = tech.macdHist < 0 && tech.macdDirection === 'falling';

  let signal = 'NEUTRAL';
  if (tech.trend === 'bullish' && tech.structure === 'bullish_stack' && momentum === 'bullish' && macdBullish) signal = 'BULLISH';
  else if (tech.trend === 'bearish' && tech.structure === 'bearish_stack' && momentum === 'bearish' && macdBearish) signal = 'BEARISH';

  const report = `
TECHNICAL ANALYSIS — ${symbol} (Bitunix futures, 1h timeframe, ${TODAY})
Price: ${(tech.price ?? 0).toFixed(2)} USDT | 24h change: ${ticker?.change24h ?? 'n/a'}% | Volume: ${ticker?.volume24h ?? 'n/a'}

Trend: Price vs EMA10 (${tech.ema10?.toFixed(2) ?? 'n/a'}), SMA50 (${tech.sma50?.toFixed(2) ?? 'n/a'}), SMA200 (${tech.sma200?.toFixed(2) ?? 'n/a'}).
Structure: ${tech.structure}. Immediate trend: ${tech.trend}.

Momentum: RSI(14) = ${rsi.toFixed(1)} → ${momentum}. MACD line ${tech.macdLine?.toFixed(4) ?? 'n/a'} vs signal ${tech.macdSignal?.toFixed(4) ?? 'n/a'}, histogram ${tech.macdHist?.toFixed(4) ?? 'n/a'} (${tech.macdDirection}).

Volatility: ATR(14) = ${tech.atr?.toFixed(4) ?? 'n/a'} (${tech.atrPct?.toFixed(2)}% of price). Bollinger position: price ${(tech.price > (tech.bbUpper ?? tech.price) ? 'above upper band' : tech.price < (tech.bbLower ?? tech.price) ? 'below lower band' : 'within bands')}. Spread: ${spread.toFixed(3)}%.

Key levels: nearest support ≈ ${tech.nearestSupport?.toFixed(2)}, nearest resistance ≈ ${tech.nearestResistance?.toFixed(2)}. BB upper ${tech.bbUpper?.toFixed(2)}, mid ${tech.bbMid?.toFixed(2)}, lower ${tech.bbLower?.toFixed(2)}.

TECHNICAL SIGNAL: ${signal}
`;

  return { signal, report, data: tech };
}

/**
 * Subagent 2 — News & Sentiment Analyst (Bitunix).
 * Bitunix has no news API. Uses funding rate history (crowded positioning),
 * current funding, and position tiers as sentiment proxies. Falls back to web
 * fetch for crypto news headlines about the symbol.
 */
async function newsSentimentAnalyst(symbol) {
  const funding = await fetchFunding(symbol);
  const history = await fetchFundingHistory(symbol, 30);
  const tiers = await fetchPositionTiers(symbol).catch(() => null);

  const fundingRate = Number(funding?.fundingRate ?? 0);
  const nextFunding = funding?.nextFundingTime ?? 'n/a';
  const intervalH = funding?.fundingInterval ?? 8;

  // Funding skew over history: % of periods with positive funding
  const rates = (history || []).map((r) => Number(r.fundingRate ?? 0)).filter((v) => Number.isFinite(v));
  const positivePct = rates.length ? (rates.filter((v) => v > 0).length / rates.length) * 100 : 50;
  const avgFunding = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

  let sentiment = 'NEUTRAL';
  let sentimentWord = 'mixed';
  if (fundingRate > 0.01 && positivePct > 60) { sentiment = 'POSITIVE'; sentimentWord = 'positive'; }
  else if (fundingRate < -0.01 && positivePct < 40) { sentiment = 'NEGATIVE'; sentimentWord = 'negative'; }

  const maxLeverage = tiers?.[0]?.leverage ?? 'n/a';
  const mmr = tiers?.[0]?.mmr ?? 'n/a';

  // Try to fetch recent crypto news headlines for the symbol
  let newsHeadlines = '';
  try {
    const base = symbol.replace('USDT', '');
    const resp = await fetch(`https://www.bitunix.com/api-docs/futures/market/get_tickers.html`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    // Bitunix has no news endpoint; we attempt a lightweight public search
    // but degrade gracefully if unreachable.
  } catch { /* ignore */ }

  const report = `
NEWS & SENTIMENT — ${symbol} (Bitunix futures, ${TODAY})
Funding rate: ${(fundingRate * 100).toFixed(4)}% per ${intervalH}h (next funding: ${nextFunding}).
Funding bias over last ${rates.length} settlements: ${positivePct.toFixed(1)}% positive, average ${(avgFunding * 100).toFixed(4)}%.
Sentiment: ${sentimentWord}.

Crowded positioning check: ${fundingRate > 0.05 ? 'Heavily positive funding — longs are crowded, risk of a long squeeze.' : fundingRate < -0.05 ? 'Heavily negative funding — shorts are crowded, risk of a short squeeze.' : 'Funding near neutral — no extreme crowding on either side.'}

Max leverage (top tier): ${maxLeverage}x | Maintenance margin rate: ${(mmr * 100).toFixed(2)}%.

SENTIMENT SIGNAL: ${sentiment}
`;

  return { signal: sentiment, report, data: { fundingRate, positivePct, avgFunding, maxLeverage, mmr } };
}

/**
 * Subagent 3 — Fundamentals Analyst (Bitunix crypto futures).
 * No P/E / balance sheet. Substitutes: funding rate (cost of carry), 24h
 * volume (liquidity), position tiers (leverage ceilings), pair specs.
 */
async function fundamentalsAnalyst(symbol) {
  const ticker = await fetchTicker(symbol);
  const specs = await fetchPairSpecs(symbol).catch(() => null);
  const tiers = await fetchPositionTiers(symbol).catch(() => null);
  const funding = await fetchFunding(symbol);

  const fundingRate = Number(funding?.fundingRate ?? 0);
  const volume24h = Number(ticker?.volume24h ?? 0);
  const price = Number(ticker?.lastPrice ?? ticker?.markPrice ?? 0);
  const change24h = Number(ticker?.change24h ?? 0);

  const maxLev = tiers?.[0]?.leverage ?? 'n/a';
  const minQty = specs?.minTradeVolume ?? 'n/a';
  const basePrec = specs?.basePrecision ?? 'n/a';
  const quotePrec = specs?.quotePrecision ?? 'n/a';

  // "Fundamental" signal for crypto: liquidity + leverage ceiling + funding cost
  let signal = 'FAIR';
  if (volume24h > 50_000_000 && maxLev >= 100 && Math.abs(fundingRate) < 0.01) signal = 'STRONG';
  else if (volume24h < 5_000_000 || Math.abs(fundingRate) > 0.05) signal = 'WEAK';

  const report = `
FUNDAMENTALS — ${symbol} (Bitunix USDT-M perpetual, ${TODAY})
Asset class: crypto futures — no P/E, balance sheet, or earnings. Substitute metrics below.

Liquidity: 24h volume ≈ ${volume24h.toLocaleString()} USDT. ${volume24h > 20_000_000 ? 'Deep liquidity, easy entry/exit.' : 'Thin liquidity — slippage risk on larger size.'}
Cost of carry: funding rate ${(fundingRate * 100).toFixed(4)}% per 8h. ${fundingRate > 0.01 ? 'Longs pay shorts — bullish funding bias.' : fundingRate < -0.01 ? 'Shorts pay longs — bearish funding bias.' : 'Neutral funding.'}
Leverage ceiling: max ${maxLev}x on the top tier. ${Number(maxLev) >= 100 ? 'High leverage available.' : 'Moderate leverage ceiling.'}
Contract specs: min trade volume ${minQty}, base precision ${basePrec}, quote precision ${quotePrec}.
24h price change: ${change24h.toFixed(2)}%.

FUNDAMENTAL SIGNAL: ${signal}
`;

  return { signal, report, data: { volume24h, fundingRate, maxLev, minQty, price, change24h } };
}

/**
 * Subagent 4 — Macro Analyst (Bitunix).
 * Uses BTCUSDT as the broad-market proxy, ETHUSDT as the altcoin beta proxy,
 * and funding rates across both for risk-on / risk-off classification.
 */
async function macroAnalyst(symbol) {
  let btc, eth;
  try { btc = await fetchTicker('BTCUSDT'); } catch { btc = null; }
  try { eth = await fetchTicker('ETHUSDT'); } catch { eth = null; }
  try { await fetchFunding('BTCUSDT'); } catch { /* ignore */ }

  const btcChange = btc ? Number(btc.change24h ?? 0) : 0;
  const ethChange = eth ? Number(eth.change24h ?? 0) : 0;

  let macro = 'NEUTRAL';
  let macroWord = 'neutral';
  if (btcChange > 2 && ethChange > 2) { macro = 'RISK-ON'; macroWord = 'risk-on'; }
  else if (btcChange < -2 && ethChange < -2) { macro = 'RISK-OFF'; macroWord = 'risk-off'; }

  const report = `
MACRO CONTEXT — ${symbol} vs broad crypto market (${TODAY})
BTCUSDT 24h: ${btcChange.toFixed(2)}% | ETHUSDT 24h: ${ethChange.toFixed(2)}%.

${macro === 'RISK-ON' ? 'Both BTC and ETH are up >2% — risk-on environment, crypto appetite is positive.' : macro === 'RISK-OFF' ? 'Both BTC and ETH are down >2% — risk-off environment, defensive posture warranted.' : 'Mixed or flat macro — no clear directional bias from the broad market.'}

Funding across majors: check BTC/ETH funding for crowded positioning before sizing.

MACRO SIGNAL: ${macro}
`;

  return { signal: macro, report, data: { btcChange, ethChange, macro } };
}

// --------------------------------------------------------------- Phase 2 debate

async function bullAnalyst(symbol, technical, news, fundamentals, macro) {
  const prompt = `You are a Bull Analyst advocating a long setup on ${symbol} (Bitunix USDT-M perpetual futures) as of ${TODAY}. Build a strong, evidence-based case emphasizing upside potential, breakout structure, and positive market indicators.

Key points:
- Upside Potential: highlight momentum, breakout structure, funding tailwinds.
- Strengths: liquidity, leverage ceiling, exchange depth.
- Positive Indicators: use technical, sentiment, and macro data below.
- Be direct and confident. 150-200 words. Use specific data points.

REPORTS:
TECHNICAL: ${technical.report}
NEWS/SENTIMENT: ${news.report}
FUNDAMENTALS: ${fundamentals.report}
MACRO: ${macro.report}

End with exactly: BULL CONVICTION: HIGH, MEDIUM, or LOW`;

  const r = await chatNonEmpty({ messages: [{ role: 'user', content: prompt }], thinking: 'medium', maxTokens: 400 }, 'bull analyst');
  return r.content;
}

async function bearAnalyst(symbol, technical, news, fundamentals, macro, bullArg) {
  const prompt = `You are a Bear Analyst making the case against a long setup on ${symbol} (Bitunix USDT-M perpetual futures). Present a well-reasoned argument emphasizing risks, challenges, and negative indicators — and directly rebut the Bull Analyst's specific claims.

Key points:
- Risks: liquidation risk, funding squeeze, adverse macro.
- Competitive weaknesses: thin liquidity, low leverage ceiling.
- Negative indicators: use technical, sentiment, macro data.
- Macro risks: broad market headwinds.
- Bull counterpoints: rebut each of the bull's specific claims below.
- Be conversational and direct. 150-200 words.

REPORTS:
TECHNICAL: ${technical.report}
NEWS/SENTIMENT: ${news.report}
FUNDAMENTALS: ${fundamentals.report}
MACRO: ${macro.report}

BULL ANALYST'S ARGUMENT:
${bullArg}

End with exactly: BEAR CONVICTION: HIGH, MEDIUM, or LOW`;

  const r = await chatNonEmpty({ messages: [{ role: 'user', content: prompt }], thinking: 'medium', maxTokens: 400 }, 'bear analyst');
  return r.content;
}

async function riskAnalyst(symbol, fundamentals, macro, bullArg, bearArg) {
  const prompt = `You are a conservative Risk Analyst for ${symbol} (Bitunix USDT-M perpetual futures). Stress-test the trade from a risk management perspective. Surface factors neither Bull nor Bear addressed.

Focus on:
- Downside scenarios: what must go wrong for a meaningful loss?
- Leverage risk: max leverage, maintenance margin, liquidation distance.
- Volatility: ATR % of price, beta to BTC.
- Crowding: funding rate extremes, one-sided consensus.
- Macro tail risks: from the macro report.
- Risks both sides glossed over.

Be specific — cite numbers (funding rate, ATR %, max leverage, BTC move).
Do not simply side with the bear. 150-200 words.

REPORTS:
FUNDAMENTALS: ${fundamentals.report}
MACRO: ${macro.report}
BULL ARGUMENT: ${bullArg}
BEAR ARGUMENT: ${bearArg}

End with exactly: RISK LEVEL: HIGH, MEDIUM, or LOW`;

  const r = await chatNonEmpty({ messages: [{ role: 'user', content: prompt }], thinking: 'medium', maxTokens: 400 }, 'risk analyst');
  return r.content;
}

// --------------------------------------------------------------- Phase 3 Research Manager

async function researchManager(symbol, bull, bear, risk) {
  const prompt = `You are the Research Manager for ${symbol} (Bitunix futures). Evaluate the bull/bear debate and deliver a clear trading plan.

Rating scale (use exactly one): Buy / Overweight / Hold / Underweight / Sell.

Commit to a clear stance whenever the debate's strongest arguments warrant one. Reserve Hold for genuinely balanced evidence.

DEBATE:
BULL: ${bull}
BEAR: ${bear}
RISK: ${risk}

Output format:
RECOMMENDATION: [Buy / Overweight / Hold / Underweight / Sell]

RATIONALE: [2-3 sentences — who won and why, citing specific evidence]

STRATEGIC ACTIONS: [2-3 sentences — entry approach, sizing, conditions to watch]`;

  const r = await chatNonEmpty({ messages: [{ role: 'user', content: prompt }], thinking: 'medium', maxTokens: 400 }, 'research manager');
  return r.content;
}

// --------------------------------------------------------------- Phase 4 Trader

async function trader(symbol, researchPlan, technical) {
  const price = Number(technical?.data?.price ?? 0);
  const atr = technical.data.atr;
  const support = technical.data.nearestSupport;
  const resistance = technical.data.nearestResistance;

  const prompt = `You are a Trader converting the Research Manager's plan into a concrete transaction proposal for ${symbol} (Bitunix USDT-M perpetual). Anchor in the analyst reports. Be specific on price levels.

INVESTMENT PLAN:
${researchPlan}

TECHNICAL REPORT (price levels):
${technical.report}

Current price: ${price.toFixed(2)} | ATR(14): ${atr?.toFixed(4)} | Support ≈ ${support?.toFixed(2)} | Resistance ≈ ${resistance?.toFixed(2)}.

Output format:
ACTION: [Buy / Hold / Sell]

REASONING: [2-3 sentences anchored in the reports — why this action, why now]

ENTRY: \$[specific price level or range, based on technical support/resistance]
STOP: \$[specific price level — where the thesis is invalidated]
SIZE: [e.g. "3-5% of portfolio, add in 2 tranches" or "maintain current position"]`;

  const r = await chatNonEmpty({ messages: [{ role: 'user', content: prompt }], thinking: 'medium', maxTokens: 400 }, 'trader');
  return r.content;
}

// --------------------------------------------------------------- Phase 5 Portfolio Manager

async function portfolioManager(symbol, researchPlan, traderProposal, bull, bear, risk) {
  const prompt = `You are the Portfolio Manager. Synthesize all inputs and deliver the final decision for ${symbol} (Bitunix USDT-M perpetual futures) as of ${TODAY}.

RESEARCH MANAGER'S PLAN:
${researchPlan}

TRADER'S PROPOSAL:
${traderProposal}

BULL ARGUMENT: ${bull}
BEAR ARGUMENT: ${bear}
RISK ANALYST: ${risk}

Output the final decision in this EXACT format:

TICKER: [ticker]
DATE: [today]
SIGNAL: [BUY / SELL / HOLD]
RATING: [Overweight / Equal Weight / Underweight]
ENTRY: \$[price from Trader]
STOP: \$[price from Trader]
SIZE: [sizing from Trader]

BULL: [one sentence — the single strongest bull argument]
BEAR: [one sentence — the single strongest bear argument]
VERDICT: [2-3 sentences — why the bull or bear case won and what specifically to do]`;

  const r = await chatNonEmpty({ messages: [{ role: 'user', content: prompt }], thinking: 'high', maxTokens: 600 }, 'portfolio manager');
  return r.content;
}

// --------------------------------------------------------------- orchestration

/**
 * Run the full 5-phase trading analysis pipeline for a Bitunix symbol.
 * Returns the complete PM decision plus all intermediate reports.
 */
export async function runAnalysis(symbol) {
  const sym = symbol.toUpperCase();
  log.info(`analysis-agent: starting 5-phase pipeline for ${sym}`);

  // Phase 1 — 4 parallel subagents
  const [technical, news, fundamentals, macro] = await Promise.all([
    technicalAnalyst(sym),
    newsSentimentAnalyst(sym),
    fundamentalsAnalyst(sym),
    macroAnalyst(sym),
  ]);
  log.info(`analysis-agent: Phase 1 complete — tech:${technical.signal} news:${news.signal} fund:${fundamentals.signal} macro:${macro.signal}`);

  const techPrice = Number(technical?.data?.price);
  if (!Number.isFinite(techPrice) || techPrice <= 0) {
    throw new Error(`No valid price feed for ${sym} on Bitunix — market data may be unavailable for this symbol`);
  }

  // Phase 2 — sequential debate
  const bull = await bullAnalyst(sym, technical, news, fundamentals, macro);
  const bear = await bearAnalyst(sym, technical, news, fundamentals, macro, bull);
  const risk = await riskAnalyst(sym, fundamentals, macro, bull, bear);
  log.info('analysis-agent: Phase 2 complete — bull/bear/risk debate done');

  // Phase 3 — Research Manager
  const researchPlan = await researchManager(sym, bull, bear, risk);

  // Phase 4 — Trader
  const traderProposal = await trader(sym, researchPlan, technical);

  // Phase 5 — Portfolio Manager
  const pmDecision = await portfolioManager(sym, researchPlan, traderProposal, bull, bear, risk);

  const result = {
    symbol: sym,
    date: TODAY,
    phase1: { technical, news, fundamentals, macro },
    phase2: { bull, bear, risk },
    phase3: researchPlan,
    phase4: traderProposal,
    phase5: pmDecision,
  };

  // Persist to long-term memory
  try {
    await db.remember({
      kind: 'analysis',
      subject: sym,
      content: `Trading analysis for ${sym} on ${TODAY}: ${pmDecision.slice(0, 500)}`,
      importance: 7,
    }).catch(() => {});
  } catch { /* best-effort */ }

  log.info(`analysis-agent: pipeline complete for ${sym}`);
  return result;
}

export default { runAnalysis };
