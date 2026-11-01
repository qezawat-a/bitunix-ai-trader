import { summarize } from '../src/ai/autopsy.js';
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
ok(s.findings.some((f) => /Payoff problem/.test(f)), 'payoff finding');
ok(s.findings.some((f) => /Winners are cut early/.test(f)), 'early-exit finding (0.4% vs planned 0.9%)');
ok(s.findings.some((f) => /Stops are tight/.test(f)), 'tight stop finding');
ok(s.findings.some((f) => /within 5 minutes/.test(f)), 'noise-stop finding');
const sh = summarize([T({ side: 'SHORT', entry_price: 100, exit_price: 99, realized_pnl: 1, sl_price: 101, tp_price: 98 })]);
ok(Math.abs(sh.avgWinMovePct - 1) < 1e-9, 'short profits when price falls');
ok(summarize([]).trades === 0, 'empty input is safe');
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
