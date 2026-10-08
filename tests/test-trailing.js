/**
 * Exercise the REAL trailingStop() from src/trading/risk.js.
 *
 * The bug this guards: positionRoi() divided PnL by the exchange's `margin`
 * field, which in CROSS mode is account-wide, not position-specific. ROI came
 * out ~10x too small, so `roiPct < beThreshold` was always true and the
 * breakeven/trailing branches were dead code. With ROI fixed, these thresholds
 * are reachable for the first time — so the thresholds themselves now need to
 * be verified.
 */

import { trailingStop } from '../src/trading/risk.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

const LONG = { side: 'LONG', entry: 10000, currentPrice: 10000, atr: 50, leverage: 10 };

console.log('=== Trailing stop / breakeven (real risk.js) ===\n');

console.log('Below breakeven threshold');
assert(trailingStop({ ...LONG, roiPct: 10 }) === null, 'ROI 10% -> null, no stop moved');
assert(trailingStop({ ...LONG, roiPct: 19.9 }) === null, 'ROI 19.9% -> null (just under 20)');

console.log('\nBreakeven band (20% <= ROI < 25%)');
const be = trailingStop({ ...LONG, currentPrice: 10200, roiPct: 20 });
assert(be !== null, 'ROI 20% -> a stop is placed');
assert(be.reason === 'breakeven', `reason is "breakeven" (got "${be.reason}")`);
assert(Math.abs(be.stop - 10000 * 1.0008) < 1e-6,
  `stop = entry + fee buffer = ${be.stop.toFixed(4)} (entry ${LONG.entry}, buffer ${(LONG.entry * 0.0008).toFixed(4)})`);
const be24 = trailingStop({ ...LONG, currentPrice: 10240, roiPct: 24 });
assert(be24.stop === be.stop, 'ROI 24% still breakeven, stop unchanged');

console.log('\nTrailing band (ROI >= 25%)');
const tr = trailingStop({ ...LONG, currentPrice: 10300, roiPct: 30 });
assert(tr.reason.includes('trailing'), `reason mentions trailing (got "${tr.reason}")`);
assert(Math.abs(tr.stop - (10300 - 50 * 0.5)) < 1e-6,
  `stop = price - 0.5*ATR = ${tr.stop.toFixed(4)} (expected ${(10300 - 25).toFixed(4)})`);

console.log('\nTrailing only ever ratchets up (LONG)');
const up = trailingStop({ ...LONG, currentPrice: 11000, roiPct: 50 });
const down = trailingStop({ ...LONG, currentPrice: 10500, roiPct: 26 });
assert(up.stop > down.stop, `higher price -> tighter stop (${up.stop.toFixed(2)} > ${down.stop.toFixed(2)})`);
const weakAtr = trailingStop({ ...LONG, currentPrice: 10300, roiPct: 30, atr: 10 });
const wideAtr = trailingStop({ ...LONG, currentPrice: 10300, roiPct: 30, atr: 200 });
assert(weakAtr.stop > wideAtr.stop,
  `tighter ATR -> tighter stop (${weakAtr.stop.toFixed(2)} > ${wideAtr.stop.toFixed(2)})`);

console.log('\nShort side is mirrored');
const sb = trailingStop({ ...LONG, side: 'SHORT', currentPrice: 9800, roiPct: 20 });
assert(Math.abs(sb.stop - 10000 * 0.9992) < 1e-6,
  `SHORT breakeven = entry - fee buffer = ${sb.stop.toFixed(4)}`);
const st = trailingStop({ ...LONG, side: 'SHORT', currentPrice: 9700, roiPct: 30 });
assert(Math.abs(st.stop - (9700 + 25)) < 1e-6, `SHORT trailing = price + 0.5*ATR = ${st.stop.toFixed(4)}`);
const shortDown = trailingStop({ ...LONG, side: 'SHORT', currentPrice: 9500, roiPct: 40 });
assert(shortDown.stop < st.stop, `SHORT: lower price -> tighter stop (${shortDown.stop.toFixed(2)} < ${st.stop.toFixed(2)})`);

console.log('\nNever placed behind liquidation');
// IMPORTANT: the clamp only ever touches stops on the LOSING side of entry.
// A stop on the profit side is already in front of liquidation — pulling it
// back to "half the liq distance" rewrote every breakeven/trailing stop to a
// fixed level BELOW entry and is exactly what made the trailing engine look
// dead (the GTCUSDT bug). These cases pin the NEW behavior.
const { clampStopInsideLiq } = await import('../src/trading/risk.js');
// 1. profit-side stop near liq: untouched, even though liq is 50 away
const profit = trailingStop({ ...LONG, currentPrice: 10300, roiPct: 30, liqPrice: 9950 });
assert(Math.abs(profit.stop - 10275) < 1e-6, `profit-side trailing stop NOT pulled down (${profit.stop.toFixed(2)}, was the old bug)`);
assert(!profit.reason.includes('clamped'), `reason has no clamp note (got "${profit.reason}")`);
// 2. mirror on the short side: stop below entry, liq above -> untouched
const profitS = trailingStop({ ...LONG, side: 'SHORT', currentPrice: 9700, roiPct: 30, liqPrice: 10050 });
assert(Math.abs(profitS.stop - 9725) < 1e-6, `SHORT profit-side stop left alone (${profitS.stop.toFixed(2)})`);
// 3. the clamp still does its job on the LOSING side (where it was designed):
//    LONG, stop 9850 is 150 below entry but liq is only 100 below -> pull to half
const lost = clampStopInsideLiq({ side: 'LONG', entry: 10000, slPrice: 9850, liqPrice: 9900, buffer: 0.5 });
assert(lost.adjusted === true && Math.abs(lost.slPrice - 9950) < 1e-9,
  `losing-side stop pulled inside liq (9850 -> ${lost.slPrice})`);
// 4. a losing-side stop already within the buffer is left alone
const inside = clampStopInsideLiq({ side: 'LONG', entry: 10000, slPrice: 9960, liqPrice: 9900, buffer: 0.5 });
assert(inside.adjusted === false && Math.abs(inside.slPrice - 9960) < 1e-9,
  `stop already inside the buffer untouched (${inside.slPrice})`);
// 5. when liq is far away the stop is left exactly where the trailing engine put it.
const unclamped = trailingStop({ ...LONG, currentPrice: 10300, roiPct: 30, liqPrice: 5000 });
assert(Math.abs(unclamped.stop - 10275) < 1e-6, `distant liq leaves the stop untouched = ${unclamped.stop.toFixed(2)}`);

console.log('\nEnd-to-end: the exact case that used to never trigger');
// Cross-margin account with 5000 total margin; a 100 USDT position PnL.
// Old code: 100/5000 = 2% -> below threshold -> stop never moved. Ever.
const { positionRoi } = await import('../src/trading/manager.js');
const roi = positionRoi({ leverage: 10, qty: 0.01, avgOpenPrice: 10000, margin: 5000, unrealizedPNL: 100 });
// notional 100, pnl 100 -> +100% on price -> 1000% at 10x. The old code
// divided by the account-wide margin (5000) and called that 2%.
assert(Math.abs(roi - 1000) < 0.1, `ROI reads ${roi.toFixed(2)}% (old code gave 2%)`);
const e2e = trailingStop({ side: 'LONG', entry: 10000, currentPrice: 11000, atr: 50, roiPct: roi });
assert(e2e !== null && e2e.reason.includes('trailing'),
  `breakeven/trailing now fires from live position data: ${JSON.stringify(e2e)}`);

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
