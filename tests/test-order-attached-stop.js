/**
 * Regression: the entry order carries its SL attached (placeOrder slPrice).
 * On Bitunix that row is an ORDER-level tp/sl; tpsl/position/modify_order
 * answers code 0 for it and changes nothing -> "Stop move failed ... exchange
 * accepted the request but did not change the order".
 *
 * upsertPositionTpSl must fall through to modify_order BY orderId, and the
 * read-back must not depend on a `side` filter (LONG/SHORT is not BUY/SELL).
 */
import bitunix from '../src/exchange/bitunix.js';
import { upsertPositionTpSl, resetStopMemory } from '../src/trading/executor.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

function install({ positionModifyWorks }) {
  resetStopMemory();
  const calls = [];
  // short, entry 116.43, original wide stop 116.75, attached to the entry order
  let book = [{ id: '555', positionId: 'P1', symbol: 'SOLUSDT', slPrice: '116.75', slQty: '2' }];
  bitunix.roundPrice = async (s, px) => px;
  bitunix.getPendingPositions = async () => [{ positionId: 'P1', qty: 2 }];
  bitunix.getPendingTpSlOrders = async (q) => {
    calls.push(['read', Object.keys(q).sort().join(',')]);
    return book;
  };
  bitunix.modifyPositionTpSl = async (b) => {
    calls.push(['modifyPosition', b.slPrice]);
    if (positionModifyWorks) book = [{ ...book[0], slPrice: b.slPrice }];
    return { ok: true };                      // code 0, but nothing changed
  };
  bitunix.modifyTpSlOrder = async (b) => {
    calls.push(['modifyOrder', b.orderId, b.slPrice, b.slQty]);
    book = [{ ...book[0], slPrice: b.slPrice }];
    return { ok: true };
  };
  bitunix.placeTpSlOrder = async (b) => { calls.push(['placeOrder', b.slPrice]); return { ok: true }; };
  bitunix.placePositionTpSl = async () => { calls.push(['placePosition']); return { ok: true }; };
  return calls;
}

console.log('\nposition modify silently ignored -> modify by orderId');
{
  const calls = install({ positionModifyWorks: false });
  const r = await upsertPositionTpSl({
    symbol: 'SOLUSDT', positionId: 'P1', slPrice: 116.4, side: 'SHORT', entry: 116.43,
  });
  assert(r.ok === true, 'move reported OK only after read-back proves it');
  assert(r.mode === 'modified-by-orderId', `mode is modified-by-orderId (got ${r.mode})`);
  assert(calls.some((c) => c[0] === 'modifyOrder' && c[1] === '555' && c[3] === '2'), 'modify_order called with the row id and qty');
  assert(!calls.some((c) => c[0] === 'placePosition'), 'did not try a bogus place_order for an existing stop');
  assert(calls.filter((c) => c[0] === 'read').every((c) => !c[1].includes('side')), 'reads never filter by side');
}

console.log('\nposition modify works -> no extra calls');
{
  const calls = install({ positionModifyWorks: true });
  const r = await upsertPositionTpSl({
    symbol: 'SOLUSDT', positionId: 'P1', slPrice: 116.4, side: 'SHORT', entry: 116.43,
  });
  assert(r.ok === true && r.mode === 'modified', 'plain position modify still used when it works');
  assert(!calls.some((c) => c[0] === 'modifyOrder'), 'modify_order not needed');
}

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
