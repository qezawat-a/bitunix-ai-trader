/**
 * Stop/target SIZING: the bracket must scale to a real (structure-TF) move,
 * and never live inside the fee band.
 *
 * Incident (2026-10-07, measured live): TIMEFRAMES=1m,3m,5m,15m sized the
 * bracket on the 1m ATR (0.05% of price) -> SL ~0.09%, TP ~0.14%, both
 * inside the 0.08-0.10% taker round trip. 50 closes: 38 at PnL ~ 0, net
 * +0.17 USDT — the account only paid commission.
 *
 * stopAtrFor() is the single pick policy shared by the executor's initial
 * bracket and the guard's trailing engine. Scenario 1 is RED until its body
 * is implemented (the human-tasked pick in src/trading/risk.js); the floor
 * scenario is green already — it pins the mechanical part.
 */
import { stopAtrFor, computeDynamicTpSl } from '../src/trading/risk.js';
import { settings } from '../src/db/index.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

console.log('=== stop/target sizing: structure ATR + fee floor ===\n');

const sig = {
  symbol: 'BTCUSDT', side: 'LONG', price: 100,
  atr: 0.05, atrPct: 0.05,            // execution-TF (1m) ATR: noise-level
  confidence: 80, agreement: 2, regime: 'RANGE', leverage: 10,
  timeframes: {
    '1m': { atr: 0.05 }, '3m': { atr: 0.09 },
    '5m': { atr: 0.14 }, '15m': { atr: 0.3 },
  },
};

console.log('the sizing ATR comes from a structure TF, not the execution one');
const pick = stopAtrFor(sig, settings());
assert(pick.tf !== '1m', `execution TF is NOT the sizing TF (got "${pick.tf}")`);
assert(Number.isFinite(pick.atr) && pick.atr > sig.atr,
  `sizing ATR (${pick.atr}) clears the noise-level execution ATR (${sig.atr})`);

console.log('\nno valid structure ATR -> fall back to the execution one');
const bare = stopAtrFor({ ...sig, timeframes: { '1m': { atr: sig.atr } } }, settings());
assert(Math.abs(bare.atr - sig.atr) < 1e-9, `fallback returns the execution ATR (${bare.atr})`);

console.log('\na fee-band floor keeps even the fallback bracket able to pay');
const s = settings();
const minPct = Number(s.min_stop_pct ?? 0.25) || 0.25;
const r = computeDynamicTpSl({ ...sig, timeframes: { '1m': { atr: sig.atr } } });
const slDistPct = Math.abs(100 - r.slPrice);
assert(slDistPct >= minPct - 1e-9,
  `SL distance ${slDistPct.toFixed(4)}% clears the floor (${minPct}%) — was inside the fee band`);

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
