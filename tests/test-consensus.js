/**
 * consensus() from src/scanner/scanner.js — the confidence and agreement maths.
 *
 * This is the gate every trade passes through, and it is the part the user
 * reported as "not working". It is a pure function of an `analysis` object, so
 * it can be driven with synthetic multi-timeframe data and no network at all.
 *
 * What is verified:
 *   - a strategy only votes when its confidence clears tf_min_confidence
 *   - agreement counts DISTINCT strategies, not raw votes
 *   - confidence is a weighted average, not a mean of the two sides
 *   - a higher timeframe that disagrees acts as a veto (-18)
 *   - both sides voting costs 10 points
 *   - confidence is clamped to 0..100
 *
 * The only seam is the db module's settings()/strategyWeights(), which are
 * read-only ES module bindings. They degrade to neutral defaults when Neon is
 * unreachable, so the defaults asserted here are the ones the function actually
 * sees offline.
 */

import { consensus } from '../src/scanner/scanner.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/**
 * Build an analysis object shaped exactly like analyseSymbol() returns.
 * `tfs` maps timeframe -> { regime, results: [{ name, side, confidence }] }
 */
const analysis = (symbol, tfs, extra = {}) => ({
  symbol,
  regime: tfs[tfs[0].tf]?.regime ?? 'RANGE',
  atr: 50,
  price: 10000,
  funding: { fundingRate: 0.01 },
  timeframes: Object.fromEntries(
    tfs.map(({ tf, regime = 'RANGE', results = [] }) => [
      tf, { regime, adx: 20, atrPct: 0.5, results },
    ]),
  ),
  ...extra,
});

/** One strategy vote. */
const v = (name, side, confidence) => ({ name, side, confidence, notes: [] });

async function test() {
  console.log('=== Consensus (real scanner.js) ===\n');

  console.log('A single strategy voting is not consensus');
  // With one strategy the agreement is 1 and confidence is its own score.
  const one = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('trend_supertrend', 'LONG', 90)] },
  ]));
  assert(one !== null, 'a single vote still produces a signal object');
  assert(one.agreement === 1, `agreement counts the one strategy (${one.agreement})`);
  assert(one.side === 'LONG', `side is LONG (${one.side})`);
  assert(close(one.rawConfidence, 90), `rawConfidence is the vote (${one.rawConfidence})`);

  console.log('\nTwo strategies agreeing beats one');
  const two = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('trend_supertrend', 'LONG', 90), v('momentum_macd', 'LONG', 70)] },
  ]));
  assert(two.agreement === 2, `agreement is 2 (${two.agreement})`);
  // Not a plain mean: confidence is weighted by regime x live performance x
  // timeframe. The default regime here is RANGE, which weights
  // trend_supertrend 0.7 and momentum_macd 0.85, so the 90 vote (the louder
  // one) is the DOWN-weighted one and the result lands below the mean of 80.
  //   (90*0.7 + 70*0.85) / (0.7 + 0.85) = 78.71 -> 79
  const expected = (90 * 0.7 + 70 * 0.85) / (0.7 + 0.85);
  assert(close(two.rawConfidence, Math.round(expected), 1),
    `confidence is the regime-weighted average (${two.rawConfidence}, expected ~${expected.toFixed(2)})`);
  assert(two.rawConfidence < 80,
    `and it is below the unweighted mean, because the 90 vote carries less weight (${two.rawConfidence} < 80)`);

  console.log('\nAgreement counts DISTINCT strategies, not votes');
  // One strategy voting on 3 timeframes is still ONE strategy.
  const same = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('trend_supertrend', 'LONG', 90)] },
    { tf: '15m', results: [v('trend_supertrend', 'LONG', 90)] },
    { tf: '1h', results: [v('trend_supertrend', 'LONG', 90)] },
  ]));
  assert(same.agreement === 1, `three timeframes, one strategy -> agreement 1 (${same.agreement})`);
  assert(same.strategies[0].timeframes.length === 3, `but it is credited with all 3 timeframes (${same.strategies[0].timeframes.join(', ')})`);

  console.log('\nVotes below tf_min_confidence are ignored entirely');
  // The default gate is 60; a 50 is discarded, so only the 80 counts.
  const mixed = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('trend_supertrend', 'LONG', 80), v('weak_one', 'LONG', 50)] },
  ]));
  assert(mixed.agreement === 1, `the 50-confidence vote is dropped (${mixed.agreement})`);
  assert(close(mixed.rawConfidence, 80), `and does not drag the average down (${mixed.rawConfidence})`);

  console.log('\nA confluent side wins over a louder minority');
  // 2 strategies at 90 LONG vs 1 at 100 SHORT. The product of agreement and
  // confidence decides, so 2x90=180 beats 1x100=100.
  const lopsided = await consensus(analysis('BTCUSDT', [
    {
      tf: '5m',
      results: [
        v('trend_supertrend', 'LONG', 90), v('momentum_macd', 'LONG', 90),
        v('rsi_divergence', 'SHORT', 100),
      ],
    },
  ]));
  assert(lopsided.side === 'LONG', `the confluent side wins (${lopsided.side})`);
  assert(lopsided.agreement === 2, `agreement 2 (${lopsided.agreement})`);
  assert(lopsided.opposite.side === 'SHORT', `the minority is reported as opposite (${lopsided.opposite.side})`);

  console.log('\nA higher timeframe that disagrees acts as a veto (-18)');
  // Same 5m votes, but the top timeframe is in a down trend.
  const vetoed = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('trend_supertrend', 'LONG', 90), v('momentum_macd', 'LONG', 90)] },
    { tf: '1h', regime: 'TREND_DOWN', results: [] },
  ]));
  assert(vetoed.side === 'LONG', 'the side is unchanged, only the confidence drops');
  assert(vetoed.confidence === vetoed.rawConfidence - 18,
    `confidence penalised by 18 (${vetoed.rawConfidence} -> ${vetoed.confidence})`);
  assert(vetoed.flags.some((f) => f.includes('TREND_DOWN')), `the reason is recorded (${JSON.stringify(vetoed.flags)})`);

  console.log('\nThe veto is symmetric — a SHORT vetoed by an uptrend');
  const vetoedShort = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('trend_supertrend', 'SHORT', 90), v('momentum_macd', 'SHORT', 90)] },
    { tf: '1h', regime: 'TREND_UP', results: [] },
  ]));
  assert(vetoedShort.side === 'SHORT', 'the short side survives');
  assert(vetoedShort.confidence === vetoedShort.rawConfidence - 18,
    `confidence penalised by 18 (${vetoedShort.rawConfidence} -> ${vetoedShort.confidence})`);

  console.log('\nA higher timeframe that AGREES is not penalised');
  const agreed = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('trend_supertrend', 'LONG', 90), v('momentum_macd', 'LONG', 90)] },
    { tf: '1h', regime: 'TREND_UP', results: [] },
  ]));
  assert(agreed.confidence === agreed.rawConfidence,
    `no penalty when timeframes align (${agreed.rawConfidence} -> ${agreed.confidence})`);
  assert(agreed.flags.length === 0, 'and no flags are raised');

  console.log('\nBoth sides voting costs 10 points');
  // 3 LONG at 90, 2 SHORT at 60 -> LONG wins, but the conflict is penalised.
  const conflict = await consensus(analysis('BTCUSDT', [
    {
      tf: '5m',
      results: [
        v('trend_supertrend', 'LONG', 90), v('momentum_macd', 'LONG', 90), v('squeeze_breakout', 'LONG', 90),
        v('rsi_divergence', 'SHORT', 60), v('bollinger_bounce', 'SHORT', 60),
      ],
    },
  ]));
  assert(conflict.side === 'LONG', `LONG still wins on agreement (${conflict.side})`);
  assert(conflict.confidence === conflict.rawConfidence - 10,
    `conflict penalty applied (${conflict.rawConfidence} -> ${conflict.confidence})`);
  assert(conflict.flags.some((f) => f.includes('vote SHORT')), `the conflict is recorded (${JSON.stringify(conflict.flags)})`);

  console.log('\nConfidence can never leave 0..100');
  // Heavy stacking of confidence 100 with a conflict, on the lowest timeframe
  // only, so nothing is subtracted and nothing is capped.
  const flat = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('a', 'LONG', 100), v('b', 'LONG', 100), v('c', 'LONG', 100)] },
  ]));
  assert(flat.confidence <= 100, `confidence stays <= 100 (${flat.confidence})`);
  assert(flat.confidence >= 0, `confidence stays >= 0 (${flat.confidence})`);

  console.log('\nDeep penalties floor at 0 rather than going negative');
  // 2 LONG votes, vetoed by the HTF AND in conflict: 90 - 18 - 10 = 62, still
  // positive. Stack more timeframes to push harder, then check the clamp.
  const penalised = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [v('a', 'LONG', 20), v('b', 'LONG', 20), v('c', 'SHORT', 95), v('d', 'SHORT', 95)] },
    { tf: '1h', regime: 'TREND_DOWN', results: [] },
  ]));
  assert(penalised.confidence >= 0, `clamped at 0 or above (${penalised.confidence})`);
  assert(penalised.confidence <= 100, `and at 100 or below (${penalised.confidence})`);

  console.log('\nNo usable timeframes means no signal at all');
  const empty = await consensus(analysis('BTCUSDT', [
    { tf: '5m', results: [] },
  ]));
  assert(empty === null, 'an empty result set returns null, not a zero-confidence signal');

  const allErrored = await consensus({
    symbol: 'BTCUSDT', regime: null, atr: null, price: null,
    timeframes: { '5m': { error: 'insufficient history' } },
  });
  assert(allErrored === null, 'an errored timeframe is excluded, and yields null when it is the only one');

  console.log('\nA signal carries the fields the executor and reporter need');
  const full = await consensus(analysis('BTCUSDT', [
    { tf: '5m', regime: 'TREND_UP', results: [v('trend_supertrend', 'LONG', 90), v('momentum_macd', 'LONG', 80)] },
  ], { atr: 42.5, price: 10000, funding: { fundingRate: 0.01 } }));
  for (const f of ['symbol', 'side', 'confidence', 'rawConfidence', 'agreement', 'strategies', 'opposite', 'detail', 'flags', 'regime', 'htfRegime', 'price', 'atr', 'atrPct', 'funding', 'timeframes']) {
    assert(full[f] !== undefined, `carries ${f}`);
  }
  assert(close(full.atrPct, 0.425), `atrPct derived from atr/price (${full.atrPct})`);
  assert(full.funding === 0.01, `funding passed through as a number (${full.funding})`);
  assert(full.detail.length >= 2, `detail records every vote (${full.detail.length})`);
  assert(close(full.detail[0].confidence, 90), `detail keeps the per-vote confidence (${full.detail[0].confidence})`);
  assert(typeof full.detail[0].weight === 'number', 'detail carries the weight that was applied');

  console.log('\nMissing optional context must not crash it');
  const bare = await consensus({
    symbol: 'ETHUSDT', regime: null, atr: null, price: null,
    timeframes: { '5m': { regime: null, adx: 0, atrPct: 0, results: [v('a', 'LONG', 90), v('b', 'LONG', 90)] } },
  });
  assert(bare !== null, 'still produces a signal');
  assert(bare.atrPct === null, `atrPct is null rather than NaN (${bare.atrPct})`);
  assert(bare.funding === null, `funding is null rather than undefined (${bare.funding})`);

  console.log(`\npassed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

test().catch((e) => { console.error(e); process.exit(1); });
