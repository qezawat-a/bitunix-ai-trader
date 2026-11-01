import { summarize, excursion, entryContext } from '../src/ai/autopsy.js';
let passed = 0, failed = 0;
const ok = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const T = (o) => ({ symbol: 'X', side: 'LONG', leverage: 10, entry_price: 100, exit_price: 100, sl_price: 99.7, tp_price: 100.9, realized_pnl: 0, close_reason: 'sl', opened_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-01T00:03:00Z', ...o });
const rows = [
  ...Array.from({ length: 8 }, () => T({ exit_price: 99.7, realized_pnl: -0.05, close_reason: 'stop_loss' })),
  T({ exit_price: 100.4, realized_pnl: 0.025, close_reason: 'breakeven_trail', closed_at: '2026-11-01T00:20:00Z' }),
  T({ exit_price: 100.4, realized_pnl: 0.025, close_reason: 'breakeven_trail', closed_at: '2026-11-01T00:25:00Z' }),
];
const s = summarize(rows);
ok(s.trades === 10 && s.wins === 2 && s.losses === 8, 'counts');
ok(Math.abs(s.breakEvenWinRate - 0.05 / 0.075) < 1e-9, 'break-even win rate = avgLoss/(avgLoss+avgWin)');
ok(s.reasons[0].reason === 'stop_loss' && s.reasons[0].n === 8, 'worst close_reason bucket first');
ok(Math.abs(s.avgWinMovePct - 0.4) < 1e-9 && Math.abs(s.avgLossMovePct + 0.3) < 1e-9, 'SHORT/LONG-aware realised move %');
ok(s.findings.some((f) => /break-even needs a/.test(f)), 'fee-adjusted break-even finding');
ok(s.findings.some((f) => /Losing trades were bigger/.test(f)) === false, 'equal sizes: no size-asymmetry finding');
ok(s.findings.some((f) => /Winners are cut early/.test(f)), 'early-exit finding (0.4% vs planned 0.9%)');
ok(s.findings.some((f) => /Stops are tight/.test(f)), 'tight stop finding');
ok(s.findings.some((f) => /within 5 minutes/.test(f)), 'noise-stop finding');
const sh = summarize([T({ side: 'SHORT', entry_price: 100, exit_price: 99, realized_pnl: 1, sl_price: 101, tp_price: 98 })]);
ok(Math.abs(sh.avgWinMovePct - 1) < 1e-9, 'short profits when price falls');
ok(summarize([]).trades === 0, 'empty input is safe');
import { inferCloseReason as inf } from '../src/trading/close-reason.js';
ok(inf({ side: 'LONG', entry: 100, exit: 100.65, sl: 99.57, tp: 100.65 }) === 'inferred_tp_hit', 'exit at TP -> tp_hit');
ok(inf({ side: 'LONG', entry: 100, exit: 99.57, sl: 99.57, tp: 100.65 }) === 'inferred_sl_hit', 'exit at SL -> sl_hit');
ok(inf({ side: 'SHORT', entry: 100, exit: 100.43, sl: 100.43, tp: 99.35 }) === 'inferred_sl_hit', 'short stop above entry -> sl_hit');
ok(inf({ side: 'LONG', entry: 100, exit: 100.2, sl: 99.57, tp: 100.65 }) === 'inferred_profit_exit_before_tp', 'small profit -> exit before TP');
ok(inf({ side: 'LONG', entry: 100, exit: 99.9, sl: 99.57, tp: 100.65 }) === 'inferred_loss_exit_before_sl', 'small loss -> exit before SL');
ok(inf({ side: 'LONG', entry: 100, exit: null, sl: 99, tp: 101 }) === 'exchange_close', 'no exit price -> unknown');
const big = summarize([T({ exit_price: 99.7, realized_pnl: -0.1, qty: 30 }), T({ exit_price: 100.9, realized_pnl: 0.02, qty: 5 })]);
ok(big.findings.some((f) => /Losing trades were bigger/.test(f)), 'size-asymmetry finding when losers carry more notional');
const ex = excursion([{ high: 100.5, low: 99.8 }, { high: 100.2, low: 99.6 }], { side: 'LONG', entry: 100 });
ok(Math.abs(ex.mfePct - 0.5) < 1e-9 && Math.abs(ex.maePct - 0.4) < 1e-9, 'LONG excursion: best +0.5%, worst -0.4%');
const exs = excursion([{ high: 100.5, low: 99.8 }], { side: 'SHORT', entry: 100 });
ok(Math.abs(exs.mfePct - 0.2) < 1e-9 && Math.abs(exs.maePct - 0.5) < 1e-9, 'SHORT excursion is mirrored');
ok(excursion([], { side: 'LONG', entry: 100 }) === null, 'no candles -> null');
const so = summarize([
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 0.5 }),
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 0.02 }),
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 0.03 }),
]);
ok(so.stopOuts.n === 3 && so.stopOuts.reachedHalfTarget === 1 && so.stopOuts.neverWorked === 2, 'stop-outs split: went toward TP first vs never worked');
ok(so.findings.some((f) => /Of 3 stop-outs/.test(f)), 'stop-out split finding');
const be = summarize([
  T({ leverage: 10, exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 0.5 }),   // arming 20/10 = 2% -> never
  T({ leverage: 40, exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 0.6 }),   // arming 20/40 = 0.5% -> reached, still lost
  T({ leverage: 40, exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 0.1 }),   // never
], { breakevenRoi: 20 });
ok(be.stopOuts.armedButLost === 1 && be.stopOuts.neverArmed === 2, 'breakeven arming level = ROI / leverage, split reached vs never');
ok(be.findings.some((f) => /10x: 2\.00%, 20x: 1\.00%, 40x: 0\.50%/.test(f)), 'arming distance per leverage is stated');
ok(be.stopOuts.bestMoveBuckets.find((b) => b.atLeastPct === 0.3).stopOuts === 2, 'best-move buckets count stop-outs by how far they went');
const cs = [{ open: 100, high: 101, low: 99.5 }, { open: 101, high: 104, low: 100.5 }];
const topLong = entryContext(cs, { side: 'LONG', entry: 103.9 });
ok(topLong.chase > 0.95 && topLong.runPct > 3.8, 'long bought near the top of the range -> chase ~1');
const botLong = entryContext(cs, { side: 'LONG', entry: 99.6 });
ok(botLong.chase < 0.1, 'long bought near the bottom -> chase ~0');
const botShort = entryContext(cs, { side: 'SHORT', entry: 99.6 });
ok(botShort.chase > 0.9, 'short sold at the bottom is chasing');
ok(entryContext([], { side: 'LONG', entry: 1 }) === null, 'no candles -> null');
const ch = summarize(Array.from({ length: 6 }, () => T({ exit_price: 99.7, realized_pnl: -0.05, chase: 0.95, runPct: 2 })));
ok(ch.findings.some((f) => /Entries chase the move/.test(f)) && ch.findings.some((f) => /Direction is lopsided/.test(f)), 'chasing and lopsided direction are reported');
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
