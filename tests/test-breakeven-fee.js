/**
 * The "breakeven" stop must actually break even.
 *
 * THE BUG: the floor sat at entry +/- 0.08%, justified as "covers 0.05% maker /
 * 0.06% taker". Both legs of these trades are TAKERS (entry is MARKET and
 * slOrderType is MARKET), so the round trip is 0.06% x2 = 0.12%. The floor was
 * 0.04% INSIDE the fee band: a winner parked there closed as a small loss, which
 * is exactly the autopsy bucket "profit exit before TP: 7 trades, 3 wins".
 *
 * This suite pins the arithmetic with the operator's real fills.
 */
import { breakevenStop, breakevenPrice, ROUND_TRIP_FEE, trailingStop } from '../src/trading/risk.js';
import { setSetting } from '../src/db/index.js';

let passed = 0, failed = 0;
const ok = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const TAKER = 0.0006;   // Bitunix taker, each leg

const netAfterFees = ({ side, entry, exit }) => {
  const move = side === 'LONG' ? (exit - entry) / entry : (entry - exit) / entry;
  return move - TAKER * 2;          // both legs paid
};

console.log('=== "Breakeven" has to mean breakeven ===\n');

console.log('The old floor (entry +/- 0.08%) was a guaranteed loss');
{
  const entry = 0.02926;
  const old = entry * 1.0008;
  ok(netAfterFees({ side: 'LONG', entry, exit: old }) < 0,
    `LONG at the old floor nets ${(netAfterFees({ side: 'LONG', entry, exit: old }) * 100).toFixed(3)}% — a loss`);
  const oldShort = entry * 0.9992;
  ok(netAfterFees({ side: 'SHORT', entry, exit: oldShort }) < 0,
    `SHORT at the old floor nets ${(netAfterFees({ side: 'SHORT', entry, exit: oldShort }) * 100).toFixed(3)}% — a loss`);
}

console.log('\nThe new floor covers both taker legs');
{
  for (const side of ['LONG', 'SHORT']) {
    const entry = 0.02926;
    const p = breakevenPrice({ side, entry });
    const net = netAfterFees({ side, entry, exit: p });
    ok(net >= 0, `${side}: closing at ${p.toFixed(6)} nets ${(net * 100).toFixed(3)}% (not negative)`);
    ok(Math.abs(Math.abs((p - entry) / entry) - ROUND_TRIP_FEE) < 1e-12, `${side}: the buffer is the round-trip fee (${ROUND_TRIP_FEE})`);
  }
  ok(ROUND_TRIP_FEE > TAKER * 2, 'and it is strictly wider than the fee band, so a tick of slippage still does not lose');
  ok(breakevenPrice({ side: 'LONG', entry: 0 }) === null, 'no entry price -> no floor (never a price of 0)');
}

console.log('\nbreakevenStop uses it, and never loosens the trade');
{
  const long = breakevenStop({ side: 'LONG', entry: 100 });
  ok(long.stop > 100 && Math.abs(long.stop - 100 * (1 + ROUND_TRIP_FEE)) < 1e-9, `LONG floor ${long.stop}`);
  const short = breakevenStop({ side: 'SHORT', entry: 100 });
  ok(short.stop < 100 && Math.abs(short.stop - 100 * (1 - ROUND_TRIP_FEE)) < 1e-9, `SHORT floor ${short.stop}`);
  // A liq price inside the fee band does not drag a profit-side floor: a stop
  // on the PROFIT side of entry is already in front of liquidation.
  const clamped = breakevenStop({ side: 'LONG', entry: 100, liqPrice: 100.05 });
  ok(Math.abs(clamped.stop - 100 * (1 + ROUND_TRIP_FEE)) < 1e-9,
    `the profit-side floor is left in front of liquidation (${clamped.stop})`);
  // A liq price below the floor does not drag a profit-side stop back.
  const losing = breakevenStop({ side: 'SHORT', entry: 100, liqPrice: 101 });
  ok(Math.abs(losing.stop - 100 * (1 - ROUND_TRIP_FEE)) < 1e-9,
    `a SHORT floor stays on the profit side of entry, below liq (${losing.stop})`);
}

console.log('\nThe trailing engine starts from the same floor');
{
  await setSetting('breakeven_threshold', 4, 'test');
  await setSetting('trailing_trigger_roi_pct', 6, 'test');
  await setSetting('trailing_distance_atr', 0.5, 'test');
  await setSetting('trailing_method', 'ATR', 'test');
  const t = trailingStop({ side: 'LONG', entry: 100, currentPrice: 100.2, atr: 0, roiPct: 5, leverage: 50 });
  ok(t && Math.abs(t.stop - 100 * (1 + ROUND_TRIP_FEE)) < 1e-9,
    `between the two thresholds the stop is the fee-aware floor (${t ? t.stop : 'none'})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
