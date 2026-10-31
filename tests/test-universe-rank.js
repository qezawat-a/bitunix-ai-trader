/**
 * rankUniverse() — the universe_rank pick order, especially the GAINERS/LOSERS
 * sign filter.
 *
 * The bug this pins: with universe_rank=GAINERS but only ~19 pairs clearing a
 * $20M volume floor and universe_size=40, the old code did
 * `sort(by chg).slice(0, size)` — which returned ALL 19 names, 10 of them DOWN
 * on the day. The user's report was literally "I set GAINERS but it isn't
 * scanning gainers". rankUniverse now drops any name that is not actually up
 * (GAINERS) / down (LOSERS), so the ceiling can never pull losers into a
 * gainers scan.
 *
 * Pure function — driven directly, no network.
 */

import { rankUniverse } from '../src/scanner/scanner.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const syms = (arr) => arr.map((x) => x.symbol);

// A pool shaped like the live probe: a couple of real gainers, some flat, some
// red, at very different volumes.
const POOL = [
  { symbol: 'WUSDT',   qv: 41e6,   range: 0.6,  price: 1, chg: 42.8 },
  { symbol: 'NEARUSDT',qv: 77e6,   range: 0.1,  price: 1, chg: 5.6 },
  { symbol: 'ZECUSDT', qv: 72e6,   range: 0.08, price: 1, chg: 4.7 },
  { symbol: 'ETHUSDT', qv: 1229e6, range: 0.03, price: 1, chg: 1.3 },
  { symbol: 'SUIUSDT', qv: 25e6,   range: 0.05, price: 1, chg: 0.0 },   // flat
  { symbol: 'BTCUSDT', qv: 1815e6, range: 0.02, price: 1, chg: -0.1 },  // red
  { symbol: 'SPCXUSDT',qv: 35e6,   range: 0.04, price: 1, chg: -0.2 },  // red
  { symbol: 'HYPEUSDT',qv: 24e6,   range: 0.07, price: 1, chg: -0.4 },  // red
  { symbol: 'XAUUSDT', qv: 54e6,   range: 0.01, price: 1, chg: -0.7 },  // red
  { symbol: 'CRASH',   qv: 22e6,   range: 0.2,  price: 1, chg: -16.5 }, // deep red
];

console.log('=== rankUniverse (universe_rank pick order) ===\n');

console.log('GAINERS returns ONLY coins that are actually up');
const gainers = rankUniverse(POOL, 'GAINERS');
assert(gainers.every((x) => x.chg > 0), 'no flat or red name survives GAINERS');
assert(syms(gainers).join(',') === 'WUSDT,NEARUSDT,ZECUSDT,ETHUSDT', `only the 4 real gainers, biggest first (got ${syms(gainers).join(',')})`);
assert(!gainers.some((x) => ['BTCUSDT', 'SPCXUSDT', 'HYPEUSDT', 'XAUUSDT', 'CRASH', 'SUIUSDT'].includes(x.symbol)),
  'the red/flat names the old code swept in are gone');

console.log('\nGAINERS is biggest-gain-first (the ceiling never pads with losers)');
assert(gainers[0].symbol === 'WUSDT', `top gainer is the +42.8% name (${gainers[0].symbol})`);
assert(gainers.length < POOL.length, `returned ${gainers.length} of ${POOL.length} — a smaller, honest universe`);

console.log('\nLOSERS is the exact mirror');
const losers = rankUniverse(POOL, 'LOSERS');
assert(losers.every((x) => x.chg < 0), 'no flat or green name survives LOSERS');
assert(losers[0].symbol === 'CRASH', `deepest fall first (${losers[0].symbol})`);
assert(!losers.some((x) => x.chg >= 0), 'a flat (chg=0) coin is neither a gainer nor a loser');

console.log('\nMOVERS keeps both directions, biggest absolute move first');
const movers = rankUniverse(POOL, 'MOVERS');
assert(movers[0].symbol === 'WUSDT', `biggest absolute move leads (+42.8) (${movers[0].symbol})`);
assert(movers.length === POOL.length, 'MOVERS keeps every name');
assert(movers[1].symbol === 'CRASH', `the -16.5% crash is #2 by |chg| (${movers[1].symbol})`);

console.log('\nVOLUME ranks by liquidity, movement only as a tie-breaker');
const vol = rankUniverse(POOL, 'VOLUME');
assert(vol[0].symbol === 'BTCUSDT', `deepest book first — BTC 1815e6 (${vol[0].symbol})`);
assert(vol[1].symbol === 'ETHUSDT', `ETH second by volume, 1229e6 (${vol[1].symbol})`);
// The thin +42.8% coin must NOT outrank ETH/BTC on volume despite its range.
assert(vol.indexOf(vol.find((x) => x.symbol === 'WUSDT')) > 1, 'a thin high-range coin does not leapfrog the majors');

console.log('\ndefault mode is VOLUME');
assert(syms(rankUniverse(POOL)).join(',') === syms(vol).join(','), 'no mode arg == VOLUME');

console.log('\nedge cases do not throw');
assert(rankUniverse([], 'GAINERS').length === 0, 'empty pool -> empty');
assert(rankUniverse(POOL, 'GAINERS').every((x) => x.chg > 0), 'still filtered');

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
