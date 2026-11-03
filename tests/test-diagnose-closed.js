/**
 * explainClosedTrade() — "why did THIS trade close here?"
 *
 * The user's /diagnose after a loss answered "no open position has been
 * evaluated by the guard", which is true and useless: the position had already
 * closed. The real question is answerable from the trade row alone — the
 * realised move against the stop and the target recorded when it opened.
 *
 * Real rows from the reported history are used as fixtures, so the verdicts are
 * checked against prices that actually happened.
 */
import { explainClosedTrade } from '../src/ai/diagnose.js';

let passed = 0, failed = 0;
const ok = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const T = (o) => ({
  symbol: 'XUSDT', side: 'LONG', entry_price: 100, exit_price: 99.3, sl_price: 99.3, tp_price: 101.3,
  realized_pnl: -0.05, close_reason: 'inferred_sl_hit',
  opened_at: '2026-11-03T14:00:00Z', closed_at: '2026-11-03T14:04:00Z', ...o,
});

console.log('=== Why did this trade close here ===\n');

console.log('A real shallow exit: ICNTUSDT -0.13% against a stop that was ~0.71% away');
{
  const r = explainClosedTrade({
    trade: T({ symbol: 'ICNTUSDT', entry_price: 0.2283, exit_price: 0.2280, sl_price: 0.226674, tp_price: 0.231, leverage: 30 }),
  });
  ok(r.category === 'possible_code_bug', `category possible_code_bug (${r.category})`);
  ok(/only \d+% of the way to the planned stop/.test(r.verdict), `verdict names the gap: ${r.verdict}`);
  ok(Math.abs(r.slPct - 0.7109) < 0.01, `the stop distance is computed from the row (${r.slPct.toFixed(2)}%)`);
  ok(r.holdMin === 4, `hold time is reported (${r.holdMin} min)`);
}

console.log('\nAn exit at the stop is not a mystery');
{
  const r = explainClosedTrade({ trade: T({ entry_price: 100, exit_price: 99.3, sl_price: 99.3 }) });
  ok(r.category === 'expected_behavior' && /AT its plan/.test(r.verdict), r.verdict);
}

console.log('\nAn exit beyond the stop is slippage, not a missing order');
{
  const r = explainClosedTrade({ trade: T({ entry_price: 100, exit_price: 98.3, sl_price: 99.3 }) });
  ok(r.category === 'exchange' && /BEYOND the planned stop/.test(r.verdict), r.verdict);
}

console.log('\nA target hit, and a profit taken before the target');
{
  const hit = explainClosedTrade({ trade: T({ entry_price: 100, exit_price: 100.9, tp_price: 100.9, realized_pnl: 0.03 }) });
  ok(hit.category === 'expected_behavior' && /AT the target/.test(hit.verdict), hit.verdict);
  const early = explainClosedTrade({ trade: T({ entry_price: 100, exit_price: 100.3, tp_price: 100.9, realized_pnl: 0.01 }) });
  ok(/well before/.test(early.verdict) && early.category === 'expected_behavior', early.verdict);
}

console.log('\nA SHORT is mirrored, and a row without a stop says so');
{
  const s = explainClosedTrade({ trade: T({ side: 'SHORT', entry_price: 100, exit_price: 100.2, sl_price: 100.35, tp_price: 99 }) });
  ok(s.movePct < 0 && s.category === 'possible_code_bug', `short loss is measured as a loss (${s.movePct.toFixed(2)}%)`);
  const none = explainClosedTrade({ trade: T({ sl_price: null }) });
  ok(none.category === 'unknown' && /no planned stop/.test(none.verdict), none.verdict);
  ok(explainClosedTrade({ trade: null }) === null, 'no trade -> no verdict');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
