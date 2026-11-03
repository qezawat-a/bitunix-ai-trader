import { summarize, excursion, entryContext, tradeCandles } from '../src/ai/autopsy.js';
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
ok(Math.abs(ex.mfeAfterEntryPct - 0.2) < 1e-9, 'lower bound excludes the entry-minute candle');
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
const tpb = summarize([
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 1.2, mfeAfterEntryPct: 0.95 }),
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 1.0, mfeAfterEntryPct: 0.3 }),
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close', mfePct: 0.2, mfeAfterEntryPct: 0.1 }),
]);
ok(tpb.stopOuts.beyondTpHi === 2 && tpb.stopOuts.beyondTpLo === 1, 'stop-outs past the planned TP counted with upper and lower bound');
ok(tpb.findings.some((f) => /went PAST their planned TP/.test(f)), 'past-TP finding');
console.log('\nThe excursion window is the trade\'s own life, not the 200 bars the endpoint returns');
{
  const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
  const MIN = 60_000;
  // 600 minutes of history. A +5% spike sits 100 minutes BEFORE the trade.
  const series = Array.from({ length: 600 }, (_, i) => ({
    time: T0 + i * MIN, open: 100,
    high: i === 400 ? 105 : 100.2,
    low: i === 400 ? 99.8 : 99.9,
    close: 100,
  }));
  // The live endpoint: `startTime` is IGNORED — it answers the last `limit` bars
  // ending at `endTime`, newest first. Reproduced exactly, because that is what
  // made every stop-out "go past its TP" (the spike was in the answer).
  const fetchKline = async ({ endTime, limit }) => series
    .filter((c) => c.time <= endTime).slice(-limit).reverse();

  const from = T0 + 500 * MIN;
  const to = T0 + 504 * MIN;
  const win = await tradeCandles({ symbol: 'XUSDT', from, to, fetchKline, page: 200 });
  ok(win.length === 5, `only the bars of the trade are used (${win.length})`);
  ok(win.every((c) => c.time >= from && c.time <= to), 'and every one of them is inside the trade');
  const exWin = excursion(win, { side: 'LONG', entry: 100 });
  ok(Math.abs(exWin.mfePct - 0.2) < 1e-9,
    `the best move is the trade's own +0.2%, not the +5% spike from before it (${exWin.mfePct})`);
  const rawPage = series.filter((c) => c.time <= to).slice(-200);
  ok(excursion(rawPage, { side: 'LONG', entry: 100 }).mfePct > 4,
    'the unfiltered page would have reported that spike as the trade\'s best move');

  // A trade longer than one page must be paged backwards to cover its own life.
  const longWin = await tradeCandles({ symbol: 'XUSDT', from: T0 + 100 * MIN, to: T0 + 449 * MIN, fetchKline, page: 200 });
  ok(longWin.length === 350, `a 350-minute trade gets all 350 bars (${longWin.length})`);
  ok(await tradeCandles({ symbol: 'XUSDT', from: to, to: from, fetchKline }) .then((x) => x.length) === 0,
    'an inverted window returns nothing instead of the whole page');
}

const unmeasured = summarize([
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close' }),
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close' }),
  T({ exit_price: 99.57, realized_pnl: -0.05, close_reason: 'exchange_close' }),
], { breakevenRoi: 20 });
ok(unmeasured.stopOuts.total === 3 && unmeasured.stopOuts.n === 0 && unmeasured.stopOuts.measured === false,
  'stop-outs with no candle data are counted but not measured');
ok(unmeasured.findings.some((f) => /only 0 had usable candles/.test(f)), 'and the report says so instead of guessing');
ok(!unmeasured.findings.some((f) => /went PAST their planned TP|went at least half-way|touched their breakeven arming level/.test(f)),
  'no excursion finding is invented from missing candles');

const exits = summarize([
  T({ exit_price: 99.95, realized_pnl: -0.02 }),   // -0.05% vs a 0.30% stop: the stop did not do this
  T({ exit_price: 99.94, realized_pnl: -0.02 }),
  T({ exit_price: 99.93, realized_pnl: -0.02 }),
  T({ exit_price: 99.70, realized_pnl: -0.05 }),   // -0.30%: right at the stop
  T({ exit_price: 99.50, realized_pnl: -0.08 }),   // -0.50%: past the stop
  T({ exit_price: 99.52, realized_pnl: -0.08 }),
]);
ok(exits.exitVsStop.n === 6 && exits.exitVsStop.shortOfStop === 3
  && exits.exitVsStop.atStop === 1 && exits.exitVsStop.beyondStop === 2,
  `losing exits are split against their OWN stop (${JSON.stringify(exits.exitVsStop)})`);
ok(exits.findings.some((f) => /closed SHALLOWER than their own planned stop/.test(f)),
  'a stop that did not close the trade is reported');
ok(exits.findings.some((f) => /closed BEYOND their planned stop/.test(f)),
  'an exit past the stop (late fill / slippage) is reported too');

console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
