/**
 * exchangePerformance() — the fee/funding sign in the reported net.
 *
 * get_history_positions documents its response as:
 *   realizedPNL  "Realized PnL(exclude funding fee and transaction fee)"
 *   fee          "Deducted transaction fees ... during the position" — positive
 *                is a cost taken out of the position
 *   funding      "total funding fee during the position" — negative is paid by
 *                the position, positive is received
 * So the account's true result is realizedPNL - fee + funding.
 *
 * THE BUG: the function reported `net: pnl + fees + funding`, adding the fee
 * back instead of subtracting it — overstating /pnl by twice the commission, in
 * exactly the direction that flatters the account. The booking path in the same
 * file already used the correct formula, so /pnl and the trade history
 * disagreed about the very same closed position.
 */
import bitunix from '../src/exchange/bitunix.js';
import { exchangePerformance } from '../src/trading/manager.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// The doc's own response example: realizedPNL 102.9, fee 0.1, funding -0.2.
const ROW = {
  positionId: '1', symbol: 'BTCUSDT', realizedPNL: '102.9', fee: '0.1', funding: '-0.2',
  closePrice: '61000', mtime: Date.now(),
};

const real = bitunix.getHistoryPositions;
bitunix.getHistoryPositions = async () => [ROW];
const r = await exchangePerformance(7);
bitunix.getHistoryPositions = real;

assert(r.trades === 1, `one closed position counted (got ${r.trades})`);
assert(close(r.pnl, 102.9), `realizedPNL reported as-is (got ${r.pnl})`);
assert(close(r.fees, 0.1), `fee reported separately (got ${r.fees})`);
assert(close(r.funding, -0.2), `funding reported separately (got ${r.funding})`);
assert(close(r.net, 102.6), `net = realizedPNL - fee + funding = 102.6 (got ${r.net})`);
assert(!close(r.net, 102.8), 'does NOT add the fee back (the old bug gave 102.8)');

console.log('\nA losing position stays negative after costs');
{
  const LOSS = { ...ROW, realizedPNL: '-10', fee: '0.4', funding: '-0.1' };
  const real2 = bitunix.getHistoryPositions;
  bitunix.getHistoryPositions = async () => [LOSS];
  const l = await exchangePerformance(7);
  bitunix.getHistoryPositions = real2;
  assert(close(l.net, -10.5), `net = -10 - 0.4 - 0.1 = -10.5 (got ${l.net})`);
  assert(l.net < l.pnl, `costs make a loss worse, not better (${l.net} < ${l.pnl})`);
}

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
