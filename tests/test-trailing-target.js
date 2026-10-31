/**
 * computeDynamicTpSl() — the open-ended "no fixed target, let it run" branch.
 *
 * THE BUG: the gate read `trailing_method === 'ATR'`, so with the setting on
 * RATIO or INTERVAL the strong-trend branch fell through to the 8R cap and the
 * adaptiveTarget "runner" branch was unreachable. Those two families DO trail —
 * RATIO/INTERVAL arm at an activation price and then close on the callback — so
 * the gate was wrong: a RATIO/INTERVAL trader was silently capped at 8R and the
 * runner branch was dead code.
 *
 * The gate is now simply "a trade is enabled", because all three families leave
 * an exchange-side stop on the position and none can strand one without an exit.
 */
import { computeDynamicTpSl } from '../src/trading/risk.js';
import { setSetting } from '../src/db/index.js';

await setSetting('trailing_method', 'ATR', 'test');
await setSetting('auto_trade', true, 'test');
await setSetting('tp_mode', 'ADAPTIVE', 'test');

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

// Strong directional trend AND a range that is still opening up -> the runner
// branch. Both are required (see adaptiveTarget).
const RUNNER = {
  side: 'LONG', price: 10000, atr: 50, confidence: 95, agreement: 5,
  regime: 'TREND_UP', adx: 35, atrExpansion: 1.2, leverage: 10, maxLeverage: 125,
};

console.log('Every trailing family gets the open-ended runner');
for (const m of ['ATR', 'RATIO', 'INTERVAL']) {
  await setSetting('trailing_method', m, 'test');
  const r = computeDynamicTpSl({ ...RUNNER });
  assert(r.tpPrice === null, `${m}: no fixed target, the trailing stop decides`);
  assert(/trailing it/.test(r.tpBasis), `${m}: basis names the trailing runner (got "${r.tpBasis}")`);
}

console.log('\nA disabled trade keeps a hard cap');
await setSetting('trailing_method', 'ATR', 'test');
await setSetting('auto_trade', false, 'test');
{
  const r = computeDynamicTpSl({ ...RUNNER });
  assert(r.tpPrice !== null, 'auto_trade=false -> a fixed target is kept');
  assert(Math.abs(r.tpPrice - (10000 + r.slDist * 8)) < 1e-6,
    `capped at 8R (${r.tpPrice}, slDist ${r.slDist})`);
  assert(/capped at 8R/.test(r.tpBasis), `basis names the 8R cap (got "${r.tpBasis}")`);
}

console.log('\nFIXED_R never uses the runner branch');
await setSetting('auto_trade', true, 'test');
await setSetting('tp_mode', 'FIXED_R', 'test');
{
  const r = computeDynamicTpSl({ ...RUNNER });
  assert(r.tpPrice !== null, 'FIXED_R -> a fixed target');
  assert(/fixed \d+\.\d+R/.test(r.tpBasis), `basis names the fixed R (got "${r.tpBasis}")`);
}

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
