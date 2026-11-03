/**
 * The take-profit must survive, and come back if it goes missing.
 *
 * WHAT THE AUTOPSY SHOWED (7 days, 34 trades): 14 stop-outs, and 13 of them
 * went PAST their planned TP distance before the stop hit. A target at that
 * price should have closed them, so either the TP row was deleted by a stop
 * move or it was never there. Two things produced that:
 *
 *   1. upsertPositionTpSl is also called with slPrice only — /be, the AI's
 *      move_sl_to_breakeven tool, set_position_tpsl. The exchange reads a
 *      missing tpPrice as "remove the take-profit", so those calls deleted the
 *      target. (An earlier fix carried the TP through; a later update dropped
 *      that block again, so it is enforced here.)
 *   2. Even when the loss was DETECTED (tp_lost_after_stop_move) nothing put
 *      the target back, so the position spent the rest of its life without one.
 *      The guard loop now re-attaches the planned TP on every pass it is missing.
 *
 * Bitunix zero-fills unused fields ("tpPrice":"0"), which is why every read
 * here treats 0/'' as "no target" instead of as a price.
 */
import bitunix from '../src/exchange/bitunix.js';
import { upsertPositionTpSl, resetStopMemory } from '../src/trading/executor.js';
import { mostProtectiveStopRow, missingTakeProfit, applyPartialTpSl } from '../src/trading/tpsl.js';
import { manageOpenPositions, resetGuardState } from '../src/trading/manager.js';
import { resetKlineCache } from '../src/scanner/scanner.js';
import { resetTrailing } from '../src/trading/tpsl.js';
import { pool, setSetting } from '../src/db/index.js';

// Hermetic DB: the loop reads the open trade record (the planned TP lives
// there) and writes events. Same stateful stub pattern as test-leverage-sync.
const seeded = {};
const TRADE = {
  position_id: '9001', client_id: 'c1', symbol: 'BTCUSDT', side: 'LONG',
  entry_price: 10000, qty: 0.01, leverage: 25, margin_mode: 'CROSS', margin_usdt: 4,
  tp_price: 11000, sl_price: 9900, atr: 50, confidence: 80, agreement: 4,
  strategies: [], status: 'OPEN',
};
let tradeTp = 11000;
pool.query = async (text, params) => {
  const sql = String(text);
  if (sql.includes('agent_settings')) {
    if (/INSERT INTO agent_settings/i.test(sql) && Array.isArray(params)) {
      seeded[params[0]] = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (/SELECT key, value FROM agent_settings/i.test(sql)) {
      return { rows: Object.entries(seeded).map(([key, value]) => ({ key, value })) };
    }
    return { rows: [] };
  }
  if (/FROM trades WHERE position_id/i.test(sql)) return { rows: [{ ...TRADE, tp_price: tradeTp }] };
  if (/FROM trades WHERE status='OPEN'/i.test(sql)) return { rows: [{ ...TRADE, tp_price: tradeTp }] };
  return { rows: [] };
};

await setSetting('account_tp_usdt', 0, 'test');
await setSetting('account_sl_usdt', 0, 'test');
// Keep breakeven/trailing out of the way: this suite is about the target only.
await setSetting('breakeven_threshold', 1000, 'test');
await setSetting('trailing_trigger_roi_pct', 1000, 'test');
await setSetting('trailing_method', 'ATR', 'test');

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

console.log('=== The take-profit survives a stop move, and comes back if it does not ===\n');

console.log('missingTakeProfit: only a REAL missing target is restored');
{
  assert(missingTakeProfit({ rows: [{ slPrice: 9900, tpPrice: '0' }], record: { tp_price: 11000 } }) === 11000,
    'a stop row with a zero-filled TP is a missing target -> the planned TP comes back');
  assert(missingTakeProfit({ rows: [{ tpPrice: 11000, slPrice: 9900 }], record: { tp_price: 11000 } }) === null,
    'a row that already carries the TP -> nothing to do');
  assert(missingTakeProfit({ rows: [{ slPrice: 9900 }], record: { tp_price: null } }) === null,
    'a trade opened without a target (ADAPTIVE runner) is not given one');
  assert(missingTakeProfit({ rows: [{ slPrice: 9900 }], record: null }) === null,
    'no trade record -> cannot know the plan, so no write');
}

console.log('\nmostProtectiveStopRow ignores zero-filled stops');
{
  const rows = [{ slPrice: '0', tpPrice: '0' }, { slPrice: 116.4, tpQty: '2' }];
  const pick = mostProtectiveStopRow(rows, 'SHORT');
  assert(pick && Number(pick.slPrice) === 116.4,
    `a "0" stop is not a stop (picked ${pick ? pick.slPrice : 'none'})`);
  assert(mostProtectiveStopRow([{ slPrice: '0' }], 'LONG') === null, 'only zero-filled rows -> no stop at all');
}


/** Exchange stub for upsertPositionTpSl. `dropTp` makes the write lose the TP. */
function installUpsert({ book, dropTp = false }) {
  resetStopMemory();
  const calls = [];
  let current = book.map((r) => ({ ...r }));
  bitunix.roundPrice = async (s, px) => px;
  bitunix.getPendingPositions = async () => [{ positionId: 'P1', qty: 2 }];
  bitunix.getPendingTpSlOrders = async () => ({ orderList: current.map((r) => ({ ...r })) });
  bitunix.modifyPositionTpSl = async (b) => {
    calls.push(['modifyPosition', b]);
    current = current.length
      ? current.map((r) => {
        const next = { ...r, ...(b.slPrice != null ? { slPrice: b.slPrice } : {}) };
        if (dropTp) delete next.tpPrice;
        else if (b.tpPrice != null) next.tpPrice = b.tpPrice;
        return next;
      })
      : [{ ...b }];
    return { ok: true };
  };
  bitunix.placePositionTpSl = async (b) => {
    calls.push(['placePosition', b]);
    current = current.map((r) => ({ ...r, ...b }));
    if (!current.length) current = [{ ...b }];
    return { ok: true };
  };
  bitunix.placeTpSlOrder = async (b) => {
    calls.push(['placeTpSlOrder', b]);
    current = [{ ...current[0], tpPrice: b.tpPrice }];
    return { ok: true };
  };
  bitunix.modifyTpSlOrder = async (b) => { calls.push(['modifyTpSlOrder', b]); return { ok: true }; };
  bitunix.cancelTpSlOrder = async (b) => { calls.push(['cancelTpSlOrder', b]); return { ok: true }; };
  return { calls, book: () => current };
}

console.log('\nA stop move without a tpPrice keeps the target that is already there');
{
  const { calls } = installUpsert({ book: [{ id: '777', positionId: 'P1', symbol: 'SOLUSDT', tpPrice: '116.0', slPrice: '116.75', slQty: '2' }] });
  const r = await upsertPositionTpSl({ symbol: 'SOLUSDT', positionId: 'P1', slPrice: 116.4, side: 'SHORT', entry: 116.43 });
  const mod = calls.find((c) => c[0] === 'modifyPosition');
  assert(r.ok === true && r.mode === 'modified', 'the stop moved');
  assert(mod && Number(mod[1].tpPrice) === 116,
    `the modify still carries the take-profit (got ${mod ? mod[1].tpPrice : 'none'})`);
  assert(r.tpPrice === 116, `the result reports the target that stayed (${r.tpPrice})`);
}

console.log('\nA zero-filled tpPrice from the caller is not a delete request');
{
  const { calls } = installUpsert({ book: [{ id: '778', positionId: 'P1', tpPrice: '116.0', slPrice: '116.75', slQty: '2' }] });
  const r = await upsertPositionTpSl({
    symbol: 'SOLUSDT', positionId: 'P1', tpPrice: '0', slPrice: 116.4, side: 'SHORT', entry: 116.43,
  });
  const mod = calls.find((c) => c[0] === 'modifyPosition');
  assert(r.ok === true, 'the stop still moved');
  assert(mod && Number(mod[1].tpPrice) === 116,
    `"0" was read as "no target", so the existing one is carried (got ${mod ? mod[1].tpPrice : 'none'})`);
}

console.log('\nA stop move that DOES drop the target puts it back');
{
  const { calls, book } = installUpsert({
    book: [{ id: '779', positionId: 'P1', tpPrice: '116.0', slPrice: '116.75', slQty: '2' }],
    dropTp: true,
  });
  const r = await upsertPositionTpSl({ symbol: 'SOLUSDT', positionId: 'P1', slPrice: 116.4, side: 'SHORT', entry: 116.43 });
  const place = calls.find((c) => c[0] === 'placeTpSlOrder');
  assert(r.ok === true, 'the stop move itself still reports OK');
  assert(r.tpRestored === true, 'and it reports that the target was restored');
  assert(place && Number(place[1].tpPrice) === 116,
    `a target-only order was placed at the lost price (${place ? place[1].tpPrice : 'none'})`);
  assert(place && String(place[1].tpQty) === '2', `for the whole position (qty ${place ? place[1].tpQty : 'none'})`);
  assert(book().some((x) => Number(x.tpPrice) > 0), 'the book now carries a take-profit again');
}

console.log('\nThe guard loop re-attaches a planned target that is missing');
{
  // Exchange: a live LONG with a stop but NO target (as if a stop move deleted
  // it). The trade record still knows the target it was opened with.
  let writes = [];
  let current = [{ positionId: '9001', symbol: 'BTCUSDT', slPrice: 9900, tpPrice: '0', slQty: 0.01 }];
  tradeTp = 11000;
  resetGuardState(); resetStopMemory(); resetKlineCache(); resetTrailing();

  bitunix.getPendingPositions = async () => [{
    positionId: '9001', symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, avgOpenPrice: 10000,
    markPrice: 10000, unrealizedPNL: 0, margin: 4, leverage: 25, liqPrice: 9600, marginMode: 'CROSS',
    entryValue: 100,
  }];
  bitunix.getPendingTpSlOrders = async () => ({ orderList: current.map((r) => ({ ...r })) });
  bitunix.pairInfo = async () => ({ maxLeverage: 125, minLeverage: 1, basePrecision: 4, quotePrecision: 2, minTradeVolume: 0.001 });
  bitunix.tierFor = async () => ({ mmr: 0.005, maxLeverage: 125 });
  bitunix.getAccount = async () => [{ available: 1000, margin: 0, frozen: 0, bonus: 0, positionMode: 'HEDGE', crossUnrealizedPNL: 0 }];
  bitunix.getKline = async () => Array.from({ length: 200 }, () => ({
    time: Date.now(), open: 10000, close: 10000, high: 10050, low: 9950, volume: 1,
  }));
  bitunix.roundPrice = async (s, px) => px;
  bitunix.modifyPositionTpSl = async (b) => { writes.push({ ...b }); current = current.map((r) => ({ ...r, ...b })); return { ok: true }; };
  bitunix.placePositionTpSl = async (b) => { writes.push({ ...b }); current = current.map((r) => ({ ...r, ...b })); return { ok: true }; };
  bitunix.placeTpSlOrder = async (b) => { writes.push({ ...b }); current = current.map((r) => ({ ...r, tpPrice: b.tpPrice })); return { ok: true }; };
  bitunix.getHistoryPositions = async () => ({ positionList: [] });
  bitunix.closeAllPositions = async () => ({ ok: true });

  const first = await manageOpenPositions({});
  const reattach = first.actions.find((a) => a.type === 'tp_reattached');
  assert(reattach !== undefined,
    `the missing target was noticed and re-attached (${JSON.stringify(first.actions.map((a) => a.type))})`);
  if (reattach) {
    assert(reattach.tp === 11000, `the target is the one the trade was opened with (${reattach.tp})`);
    assert(reattach.ok === true, 'and the re-attach succeeded');
  }
  assert(current.some((r) => Number(r.tpPrice) === 11000), 'the book now carries the target');
  assert(writes.length >= 1 && writes.some((w) => Number(w.tpPrice) === 11000),
    `a write carried the target (${JSON.stringify(writes.map((w) => w.tpPrice))})`);

  // Second pass: the target is there, so nothing is written again.
  writes = [];
  const second = await manageOpenPositions({});
  assert(!second.actions.some((a) => a.type === 'tp_reattached'), 'a second pass does not re-attach it again');
  assert(writes.length === 0, `and writes nothing (${writes.length})`);
}

console.log('\nA runner trade (no planned target) is left alone');
{
  const writes = [];
  const current = [{ positionId: '9001', symbol: 'BTCUSDT', slPrice: 9900, tpPrice: '0', slQty: 0.01 }];
  tradeTp = null;
  resetGuardState(); resetStopMemory(); resetKlineCache(); resetTrailing();
  bitunix.getPendingTpSlOrders = async () => ({ orderList: current.map((r) => ({ ...r })) });
  bitunix.modifyPositionTpSl = async (b) => { writes.push({ ...b }); return { ok: true }; };
  bitunix.placePositionTpSl = async (b) => { writes.push({ ...b }); return { ok: true }; };
  bitunix.placeTpSlOrder = async (b) => { writes.push({ ...b }); return { ok: true }; };

  const r = await manageOpenPositions({});
  assert(!r.actions.some((a) => a.type === 'tp_reattached'),
    'a trade that was opened without a target is not given one');
  assert(!writes.some((w) => Number(w.tpPrice) > 0), 'and no target was written');
  tradeTp = 11000;
}

console.log('\nAnother position\'s bracket on the same symbol does not pass for ours');
{
  // The exchange returns a row for position 9999 only. The old read kept any
  // row for the symbol, so this position looked protected: the rescue never
  // attached a bracket of its own and the ratchet measured against 9999's
  // tighter stop, so a winner that reached breakeven never moved its stop.
  let writes = [];
  const current = [{ positionId: '9999', symbol: 'BTCUSDT', slPrice: 12000, tpPrice: 11000, slQty: 0.01 }];
  tradeTp = 11000;
  await setSetting('breakeven_threshold', 4, 'test');
  await setSetting('trailing_trigger_roi_pct', 1000, 'test');
  resetGuardState(); resetStopMemory(); resetKlineCache(); resetTrailing();

  bitunix.getPendingTpSlOrders = async () => ({ orderList: current.map((r) => ({ ...r })) });
  // +1.00 USDT on a 100 USDT notional at 25x = 25% ROI: past breakeven.
  bitunix.getPendingPositions = async () => [{
    positionId: '9001', symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, avgOpenPrice: 10000,
    markPrice: 10000, unrealizedPNL: 1, margin: 4, leverage: 25, liqPrice: 9600, marginMode: 'CROSS',
    entryValue: 100,
  }];
  const applyWrite = (b) => {
    writes.push({ ...b });
    const idx = current.findIndex((r) => String(r.positionId) === String(b.positionId));
    if (idx >= 0) current[idx] = { ...current[idx], ...b };
    else current.push({ ...b, positionId: String(b.positionId) });
  };
  bitunix.modifyPositionTpSl = async (b) => { applyWrite(b); return { ok: true }; };
  bitunix.placePositionTpSl = async (b) => { applyWrite(b); return { ok: true }; };
  bitunix.placeTpSlOrder = async (b) => { applyWrite(b); return { ok: true }; };

  const r = await manageOpenPositions({});
  assert(r.actions.some((a) => a.type === 'tpsl_attached'),
    `a bracket was attached for OUR position (${JSON.stringify(r.actions.map((a) => a.type))})`);
  const moved = r.actions.find((a) => a.type === 'stop_moved');
  assert(moved !== undefined, 'and the winner at 25% ROI still had its stop moved');
  assert(writes.every((w) => String(w.positionId) === '9001'),
    `every write targets our position (${JSON.stringify(writes.map((w) => w.positionId))})`);

  await setSetting('breakeven_threshold', 1000, 'test');
}


console.log('\nA 4-rung ladder on a small position is merged, not silently dropped');
{
  const placed = [];
  bitunix.pairInfo = async () => ({ minTradeVolume: 5, quotePrecision: 2, basePrecision: 2 });
  bitunix.roundQty = async (s, q) => Number(q).toFixed(2);
  bitunix.roundPrice = async (s, px) => px;
  bitunix.placeTpSlOrder = async (b) => { placed.push({ ...b }); return { ok: true, orderId: `o${placed.length}` }; };

  // 10 units of the position split four ways = 2.5 each: below the exchange
  // minimum of 5, so each small rung rolls into the next one instead of
  // vanishing (which used to leave the trade with no take-profit at all).
  const r = await applyPartialTpSl({
    symbol: 'XUSDT', positionId: 'P1', side: 'LONG', entry: 100, qty: 10, slDist: 1,
    ladder: '25@1,25@1.4,25@1.6,25@3',
  });
  assert(r.ok === true, 'rungs were placed');
  assert(r.placed.length === 2, `two placeable rungs instead of none (${r.placed.length})`);
  assert(r.placed.reduce((a, x) => a + x.share, 0) === 100,
    `the whole position is covered by the merged rungs (${r.placed.map((x) => `${x.share}%@${x.r}R`).join(' · ')})`);
  assert(r.placed.every((x) => Number(x.qty) >= 5), 'every rung clears the exchange minimum');
  assert(r.placed[0].price === 101.4 && r.placed[1].price === 103, 'merged rungs keep the later prices');
}

console.log('\nA position too small to split keeps ONE target at the outermost rung');
{
  const placed = [];
  bitunix.pairInfo = async () => ({ minTradeVolume: 100, quotePrecision: 2, basePrecision: 2 });
  bitunix.roundQty = async (s, q) => Number(q).toFixed(2);
  bitunix.roundPrice = async (s, px) => px;
  bitunix.placeTpSlOrder = async (b) => { placed.push({ ...b }); return { ok: true }; };

  const r = await applyPartialTpSl({
    symbol: 'XUSDT', positionId: 'P1', side: 'SHORT', entry: 100, qty: 2, slDist: 1,
    ladder: '40@1,35@2,25@3',
  });
  assert(r.ok === false && placed.length === 0, 'no rung could be placed');
  assert(r.fallbackTp === 97, `the outermost rung is offered as the fallback target (${r.fallbackTp})`);

  const m = missingTakeProfit({
    rows: [{ slPrice: 101 }], record: { side: 'SHORT', entry_price: 100, sl_price: 101, tp_price: null },
    ladder: [{ share: 40, r: 1 }, { share: 35, r: 2 }, { share: 25, r: 3 }],
  });
  assert(m === 97, `and the guard computes the same target from the record (${m})`);
}

console.log('\nA PARTIAL trade whose rungs all failed gets its outermost rung back');
{
  let writes = [];
  const current = [{ positionId: '9001', symbol: 'BTCUSDT', slPrice: 9900, tpPrice: '0', slQty: 0.01 }];
  tradeTp = null;   // ADAPTIVE runner: the ladder was the only plan, and it failed
  await setSetting('tpsl_method', 'PARTIAL', 'test');
  await setSetting('partial_tp_ladder', '40@1,35@2,25@3', 'test');
  resetGuardState(); resetStopMemory(); resetKlineCache(); resetTrailing();

  bitunix.getPendingTpSlOrders = async () => ({ orderList: current.map((r) => ({ ...r })) });
  bitunix.getPendingPositions = async () => [{
    positionId: '9001', symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, avgOpenPrice: 10000,
    markPrice: 10000, unrealizedPNL: 0, margin: 4, leverage: 25, liqPrice: 9600, marginMode: 'CROSS',
    entryValue: 100,
  }];
  const applyWrite = (b) => {
    writes.push({ ...b });
    const idx = current.findIndex((r) => String(r.positionId) === String(b.positionId));
    if (idx >= 0) current[idx] = { ...current[idx], ...b };
    else current.push({ ...b, positionId: String(b.positionId) });
  };
  bitunix.modifyPositionTpSl = async (b) => { applyWrite(b); return { ok: true }; };
  bitunix.placePositionTpSl = async (b) => { applyWrite(b); return { ok: true }; };
  bitunix.placeTpSlOrder = async (b) => { applyWrite(b); return { ok: true }; };

  const r = await manageOpenPositions({});
  const reattach = r.actions.find((a) => a.type === 'tp_reattached');
  assert(reattach !== undefined,
    `the empty ladder was noticed (${JSON.stringify(r.actions.map((a) => a.type))})`);
  // stop distance = 100 (entry 10000, stop 9900), outermost rung 3R
  assert(reattach && reattach.tp === 10300, `one target at 3R was attached (${reattach ? reattach.tp : 'none'})`);
  assert(writes.some((w) => Number(w.tpPrice) === 10300), 'and the write carried it');

  await setSetting('tpsl_method', 'POSITION', 'test');
  tradeTp = 11000;
}

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);


