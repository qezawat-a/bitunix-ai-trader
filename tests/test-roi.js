/**
 * positionRoi() from src/trading/manager.js.
 *
 * THE BUG: the old implementation was
 *     ROI = (PnL / margin) * 100
 * where `margin` is whatever the exchange put on the position. In CROSS margin
 * mode that field is the account-wide margin, not the position's own — so a
 * position with 500 USDT of margin on a 5000 USDT account reported 2% instead
 * of 20%. Every downstream consumer compared that number against the
 * breakeven_threshold (20) and trailing_trigger_roi_pct (25), so neither branch
 * was ever reachable. The stops looked configured and simply never fired.
 *
 * THE FIX: derive ROI from notional and leverage, which are unambiguous in
 * both margin modes:
 *     ROI = PnL * leverage / notional * 100
 */

import { positionRoi } from '../src/trading/manager.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/** Build a position the way the exchange reports one. */
const pos = ({ side = 'LONG', leverage, qty, entry, pnl, margin }) => ({
  symbol: 'BTCUSDT', side, leverage, qty,
  avgOpenPrice: entry,
  unrealizedPNL: pnl,
  margin,
});

console.log('=== ROI (real manager.js) ===\n');

console.log('Cross margin — the case that broke everything');
// notional 0.05 x 10000 = 500, margin 500, so 10x. A 100 USDT PnL is a 20%
// move on the position, which is 200% on the margin.
const cross = pos({ leverage: 10, qty: 0.05, entry: 10000, pnl: 100, margin: 5000 });
const crossRoi = positionRoi(cross);
assert(close(crossRoi, 200), `100 USDT PnL on 500 USDT margin -> ${crossRoi.toFixed(4)}% (want 200%)`);
assert(close(100 / 5000 * 100, 2), 'sanity: the old formula gave 2%, 100x too small');

console.log('\nIsolated margin — must not regress');
const iso = pos({ leverage: 5, qty: 0.5, entry: 2000, pnl: 20, margin: 200 });
assert(close(positionRoi(iso), 10), `20 on 200 -> ${positionRoi(iso).toFixed(4)}% (want 10%)`);

console.log('\nShort side');
const short = pos({ side: 'SHORT', leverage: 10, qty: 1, entry: 50000, pnl: 500, margin: 10000 });
assert(close(positionRoi(short), 10), `short profit -> ${positionRoi(short).toFixed(4)}% (want 10%)`);
const shortLoss = pos({ side: 'SHORT', leverage: 10, qty: 1, entry: 50000, pnl: -500, margin: 10000 });
assert(close(positionRoi(shortLoss), -10), `short loss -> ${positionRoi(shortLoss).toFixed(4)}% (want -10%)`);

console.log('\nLosses are negative and symmetric');
// notional 0.1 x 10000 = 1000, at 20x -> 50 USDT of margin.
for (const [pnl, want] of [[-250, -500], [-50, -100], [0, 0]]) {
  const r = positionRoi(pos({ leverage: 20, qty: 0.1, entry: 10000, pnl, margin: 5000 }));
  assert(close(r, want), `pnl ${pnl} -> ${r.toFixed(4)}% (want ${want}%)`);
}

console.log('\nLeverage scales ROI linearly');
// notional 0.1 x 10000 = 1000; 50 USDT of PnL is 5% on price.
const base = { qty: 0.1, entry: 10000, pnl: 50, margin: 10000 };
for (const [lev, want] of [[1, 5], [5, 25], [10, 50], [50, 250], [125, 625]]) {
  const r = positionRoi(pos({ ...base, leverage: lev }));
  assert(close(r, want, 1e-9), `${lev}x -> ${r.toFixed(4)}% (want ${want}%)`);
}

console.log('\nROI is independent of how much margin the account holds');
// Same position, three different account sizes. The old code produced three
// different answers for one position.
const answers = [500, 5000, 100000].map((m) =>
  positionRoi(pos({ leverage: 10, qty: 0.05, entry: 10000, pnl: 100, margin: m })));
assert(answers.every((a) => close(a, 200)), `account margin 500/5000/100000 all give ${answers.map((a) => a.toFixed(2)).join(' / ')}%`);

console.log('\nnotional is used when present, derived from qty x entry when not');
const withNotional = { leverage: 10, notional: 500, unrealizedPNL: 50, margin: 5000 };
assert(close(positionRoi(withNotional), 100), `explicit notional honoured -> ${positionRoi(withNotional)}%`);
const withoutNotional = { leverage: 10, qty: 0.05, avgOpenPrice: 10000, unrealizedPNL: 50, margin: 5000 };
assert(close(positionRoi(withoutNotional), 100), `derived notional agrees -> ${positionRoi(withoutNotional)}%`);

console.log('\nDegraded / missing fields do not produce NaN');
const cases = [
  ['no margin, no notional', { leverage: 10, qty: 0, avgOpenPrice: 0, unrealizedPNL: 0 }],
  ['zero leverage', { leverage: 0, qty: 0.05, avgOpenPrice: 10000, unrealizedPNL: 100 }],
  ['no pnl field', { leverage: 10, qty: 0.05, avgOpenPrice: 10000 }],
  ['empty object', {}],
];
for (const [label, p] of cases) {
  const r = positionRoi(p);
  assert(Number.isFinite(r), `${label} -> finite (${r})`);
}
assert(close(positionRoi({ leverage: '10', qty: '0.05', avgOpenPrice: '10000', unrealizedPNL: '100' }), 200),
  'string numbers coerce correctly');
// leverage 0 is falsy and falls back to the 1x default rather than dividing by 0
assert(close(positionRoi({ leverage: 0, qty: 0.05, avgOpenPrice: 10000, unrealizedPNL: 100 }), 20),
  'a missing leverage falls back to 1x, not a division by zero');

console.log('\nThe fallback path: isolated margin with no notional available');
// Nothing to derive notional from, so margin is the only evidence left.
const marginOnly = { leverage: 10, qty: 0, avgOpenPrice: 0, unrealizedPNL: 50, margin: 500 };
assert(close(positionRoi(marginOnly), 10), `margin-only fallback -> ${positionRoi(marginOnly)}% (want 10%)`);

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);