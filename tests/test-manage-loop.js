/**
 * manageOpenPositions() from src/trading/manager.js — the LIVE manage+guard
 * loop, driven end to end.
 *
 * This is the suite that closes the gap the user asked about. test-trailing.js
 * proves trailingStop() is correct in isolation; this proves the LOOP actually
 * reaches it, feeds it the right number, and writes the stop back.
 *
 * Why it matters: before the ROI fix, this loop was running every 15 seconds
 * and never once moving a stop, because positionRoi() reported ~2% in CROSS
 * margin mode and both thresholds are 20/25. A correct function that is never
 * called correctly is still broken, so the wiring is verified here explicitly.
 *
 * The seams are the three things that would otherwise touch the outside world:
 *   - bitunix (a singleton instance) for positions, candles, pending TP/SL and
 *     the order write
 *   - scanner.getCandles for the ATR
 *   - the db read/write helpers, which are imported as live bindings and fall
 *     back to neutral defaults when Neon is unreachable
 * Everything under test — manageOpenPositions, positionRoi, trailingStop,
 * computeDynamicTpSl, evaluateAccountTpSl, upsertPositionTpSl — is the real
 * shipped code.
 */

import bitunix from '../src/exchange/bitunix.js';
import { manageOpenPositions, positionRoi, resetGuardState } from '../src/trading/manager.js';
import { resetSymbolConfigCache, resetStopMemory } from '../src/trading/executor.js';
import { resetKlineCache } from '../src/scanner/scanner.js';
import { trailingStop } from '../src/trading/risk.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/** Record every TP/SL write the loop makes. */
let writes = [];
/** What the exchange's pending TP/SL book currently holds — the read-back
 *  verification added after the GTCUSDT bug compares the write against THIS.
 *  place/modify must update it, or every write reads back as "unchanged". */
let pendingBook = [];
/** The position the exchange will report. */
let livePos = [];
/** ATR fed to the loop: the half-range of each synthetic bar. */
let atr = 50;
/** Centre price of the synthetic candles, i.e. the current market price. */
let centre = 10000;
/** Move the synthetic market, i.e. what the loop reads as the current price. */
const setCentre = (px) => { centre = px; };

/**
 * Wipe every piece of cross-scenario state, so each scenario below starts clean.
 *
 * There are THREE independent stores that survive a pass, and a suite that only
 * clears one of them will produce confident nonsense:
 *
 *   1. manager.js   lastStop / seenPositions — the loop's own ratchet
 *   2. executor.js  bestStop — a SECOND ratchet, enforced inside upsertPositionTpSl
 *   3. scanner.js   klineCache — 10s TTL, so "price fell" reads the old price
 *
 * Finding #2 is what made this suite lie. A scenario that trailed a stop to
 * 10008 left bestStop holding it; the next scenario's rescue stop wanted 9860,
 * the guard correctly refused to loosen a locked-in stop, and the write that
 * came back read "SL 10008 / TP 10210". That looked like the rescue path
 * producing a stop ABOVE entry on a flat position — a serious bug. It was not:
 * it was this suite failing to isolate itself.
 */
const reset = () => { resetGuardState(); resetStopMemory(); resetKlineCache(); };

/**
 * A position exactly as the exchange reports it, in CROSS margin mode.
 *
 * `liqPrice` defaults to 9100, which is what a real 10x long liquidates at
 * (roughly 10% below entry). This matters: clampStopInsideLiq() may only put
 * the stop at (1 - liq_distance) of the way to liquidation, so with a
 * liq_distance of 0.5 and a 10x long, NO stop can ever sit above 9550. That
 * means breakeven and trailing are geometrically impossible at this leverage —
 * correctly so. Fixtures that expect a profitable stop must raise the
 * leverage so the liquidation distance exceeds the stop distance.
 */
const mkPos = (o = {}) => ({
  positionId: '9001', symbol: 'BTCUSDT', side: 'LONG', qty: 0.01,
  avgOpenPrice: 10000, markPrice: 10000, unrealizedPNL: 0, margin: 5000, // 5000 = ACCOUNT margin
  leverage: 10, liqPrice: 9100, marginMode: 'CROSS',
  notional: undefined, // force livePositions() to derive it: qty x entry = 100
  ...o,
});

/** Install the stubs. Called before each scenario. */
function install() {
  writes = [];
  pendingBook = [];
  livePos = [];
  atr = 50;
  centre = 10000;
  reset();

  bitunix.getPendingPositions = async () => livePos;
  bitunix.getPendingTpSlOrders = async () => pendingBook;
  bitunix.getHistoryPositions = async () => ({ positionList: [] });
  bitunix.pairInfo = async () => ({ maxLeverage: 125, minLeverage: 1, basePrecision: 4, minTradeVolume: 0.001 });
  bitunix.tierFor = async () => ({ mmr: 0.005, maxLeverage: 125 });
  bitunix.getAccount = async () => [{ available: 10000, margin: 0, frozen: 0, bonus: 0, walletBalance: 10000 }];
  bitunix.closeAllPositions = async () => ({ ok: true });
  // Both TP/SL writes land here, so capturing them records every stop the loop
  // pushes to the exchange. roundPrice is the other thing upsert needs.
  bitunix.roundPrice = async (symbol, px) => px;
  // A write must be visible to the next read-back, or verifyStopApplied — which
  // refuses to record a stop the exchange book does not show — fails every pass.
  bitunix.placePositionTpSl = async (body) => { writes.push({ ...body }); pendingBook = [{ ...body }]; return { ok: true }; };
  bitunix.modifyPositionTpSl = async (body) => { writes.push({ ...body }); pendingBook = pendingBook.length ? [{ ...pendingBook[0], ...body }] : [{ ...body }]; return { ok: true }; };

  // Candles drive BOTH the ATR and the current price the loop treats as the
  // market (it takes the last close, not the position's markPrice). Left
  // unstubbed it reads live market data, so the stop distance — and therefore
  // whether the liq clamp engages at all — would depend on what BTC did today.
  // Synthetic bars centred on `centre` make the geometry checkable.
  // getCandles() pages 200 rows a page and caches for 10s, hence 200 bars.
  bitunix.getKline = async () => Array.from({ length: 200 }, (_, i) => ({
    time: Date.now() - (200 - i) * 60_000, open: centre, close: centre,
    high: centre + atr, low: centre - atr, volume: 1,
  }));
}

/** One pass of the real loop. */
const pass = async () => manageOpenPositions({});

async function test() {
  console.log('=== Manage/guard loop end to end (real manager.js) ===\n');

  console.log('The exchange book is read and each position gets a live ROI');
  // notional = 0.01 x 10000 = 100. margin field is 5000 (the ACCOUNT total).
  // A 100 USDT PnL is +100% on price => 1000% on margin at 10x.
  install();
  reset();
  livePos = [mkPos({ unrealizedPNL: 100 })];
  const live = await manageOpenPositions({});
  const p = live.positions[0];
  assert(live.positions.length === 1, 'the position came back from the exchange');
  assert(p.leverage === 10 && p.avgOpenPrice === 10000, 'numeric fields are coerced');
  assert(p.notional === 100, `notional derived from qty x entry (${p.notional})`);
  assert(p.margin === 5000, 'the raw (account-wide) margin is passed through unchanged');
  assert(close(p.roi, 1000), `ROI computed on position margin, not account margin (${p.roi}%, old code gave 2%)`);

  console.log('\nA position with no stop gets one attached — never left naked');
  pendingBook = [];   // exchange has nothing
  livePos = [mkPos({ unrealizedPNL: 0 })];
  reset();
  writes = [];
  await pass();
  assert(writes.length >= 1, `a TP/SL was written (${writes.length} write(s))`);
  assert(writes[0].slPrice > 0, `the stop is a real price (${writes[0].slPrice})`);
  assert(writes[0].tpPrice > 0, `and so is the target (${writes[0].tpPrice})`);
  // A zero-PnL position at 25x has ROI 0, which is below breakeven_threshold, so
  // the synthetic stop is a wide ATR stop clamped inside liq. It is still a
  // real bracket: the target must be above entry and the stop below it.
  assert(writes[0].slPrice < 10000 && writes[0].tpPrice > 10000,
    `a LONG brackets entry: SL ${writes[0].slPrice} < entry 10000 < TP ${writes[0].tpPrice}`);

  console.log('\nA position that already has a stop is left alone');
  pendingBook = [{ tpPrice: 11000, slPrice: 9900 }];
  livePos = [mkPos({ unrealizedPNL: 0 })];
  reset();
  writes = [];
  await pass();
  assert(writes.length === 0, `no rescue stop overwrote the existing one (${writes.length} writes)`);

  console.log('\n*** THE BUG: a winner in CROSS margin mode now moves its stop ***');
  // Everything the old code needed to fail the way it did:
  //   margin: 5000  (account-wide, the trap)
  //   notional 100, pnl 100 -> a 1000% ROI that the old formula called 2%
  // 25x, not 10x, so the liquidation distance (~400 points) can actually hold
  // a stop above entry. At 10x the clamp makes that geometrically impossible —
  // see the note on mkPos().
  pendingBook = [{ tpPrice: 12000, slPrice: 9900 }];
  livePos = [mkPos({ unrealizedPNL: 100, markPrice: 11000, leverage: 25, liqPrice: 9600 })];
  reset();
  writes = [];
  const won = await pass();
  const moved = won.actions.find((a) => a.type === 'stop_moved');
  assert(moved !== undefined,
    `the stop was moved — old code produced no action at all (${JSON.stringify(won.actions.map((a) => a.type))})`);
  if (moved) {
    assert(moved.stop > 10000, `the stop is now ABOVE entry, locking in profit (SL ${moved.stop} > entry 10000)`);
    assert(moved.stop < 11000, `but still below the market, so it is a stop not a take-profit (${moved.stop} < 11000)`);
    assert(String(moved.reason).length > 0, `the reason is recorded ("${moved.reason}")`);
    // 25x: ROI = pnl x leverage / notional x 100 = 100 x 25 / 100 x 100
    assert(close(moved.roi, 2500), `and it reports the ROI that triggered it (${moved.roi}%)`);
  }
  assert(writes.length === 1, `exactly one order was written (${writes.length})`);
  assert(writes[0].slPrice > 10000, `and the write carries the improved stop (${writes[0].slPrice})`);

  console.log('\nThe breakeven band moves the stop to entry, not past it');
  // ROI of exactly breakeven_threshold (20): stop to entry + a fee buffer.
  // pnl 20 on notional 100 at 25x -> 20 x 25 / 100 = 20%. Again 25x, so the
  // clamp does not veto a stop sitting just above entry.
  pendingBook = [{ tpPrice: 12000, slPrice: 9900 }];
  livePos = [mkPos({ unrealizedPNL: 20, markPrice: 10200, leverage: 25, liqPrice: 9600 })];
  reset();
  writes = [];
  const be = await pass();
  const beMove = be.actions.find((a) => a.type === 'stop_moved');
  assert(beMove !== undefined, 'the stop moved at the breakeven threshold');
  if (beMove) {
    assert(beMove.reason === 'breakeven' || String(beMove.reason).includes('breakeven'),
      `reason is breakeven ("${beMove.reason}")`);
    assert(beMove.stop >= 10000 && beMove.stop < 10050,
      `stop sits just above entry to cover fees (${beMove.stop})`);
  }

  console.log('\nA small loss never touches the stop');
  pendingBook = [{ tpPrice: 11000, slPrice: 9900 }];
  livePos = [mkPos({ unrealizedPNL: -50, markPrice: 9800 })];
  reset();
  writes = [];
  const loss = await pass();
  assert(!loss.actions.find((a) => a.type === 'stop_moved'),
    'a losing position keeps its stop exactly where it was');

  console.log('\nThe stop only ever ratchets in the right direction');
  // TWO consecutive passes with NO reset between them — the carried state is
  // exactly what is under test here. qty 0.1 (notional 1000) at 4x, so that both
  // prices clear the thresholds on a physically consistent PnL and the liq price
  // stays far enough away that the clamp never enters the picture.
  //   pass 1 @ 11000: pnl 100 -> ROI 40% -> trail = 11000 - 0.5 x ATR100 = 10950
  //   pass 2 @ 10600: pnl  60 -> ROI 24% -> still past breakeven but below the
  //                    trailing trigger, so the engine drops back to entry + fees
  //                    = 10008. That is LOOSER, and must be refused.
  pendingBook = [{ tpPrice: 12000, slPrice: 9900 }];
  reset();
  livePos = [mkPos({ qty: 0.1, unrealizedPNL: 100, markPrice: 11000, leverage: 4, liqPrice: 7550 })];
  setCentre(11000);
  writes = [];
  const first = await pass();
  assert(first.actions.some((a) => a.type === 'stop_moved'),
    `pass 1 trailed the stop (${JSON.stringify(first.actions.map((a) => a.type))})`);
  const locked = writes[0]?.slPrice;
  assert(locked > 10000, `up to ${locked}, above entry`);

  // Ask the engine directly what it would do at the lower price. Without this
  // the assertion below would also pass if the engine had produced the same
  // stop for some unrelated reason.
  const would = trailingStop({
    side: 'LONG', entry: 10000, currentPrice: 10600, atr: 100, roiPct: 24, leverage: 4, liqPrice: 7550,
  });
  assert(would && would.stop < locked,
    `and at the lower price it really does want a looser stop (${would?.stop} < ${locked})`);

  writes = [];
  livePos = [mkPos({ qty: 0.1, unrealizedPNL: 60, markPrice: 10600, leverage: 4, liqPrice: 7550 })];
  setCentre(10600);
  await pass();
  assert(writes.length === 0,
    `price fell but the stop did not loosen (${writes.length} writes) — ratchet holds at ${locked}`);

  console.log('\nA profit-side stop survives a nearby liquidation price');
  // The old clamp pulled this down to liq + half the distance (9995), which is
  // BELOW entry — rewriting the very stop it was protecting. That silent
  // rewrite was the GTCUSDT bug: every write "succeeded" with the same value,
  // the ratchet saw no change, and the book kept its original wide stop. With
  // liq at 9990 and entry at 10000 the breakeven stop 10008 sits ABOVE entry,
  // i.e. in front of liquidation, so it must land exactly where the engine put
  // it and the operator's log line must not claim a clamp happened.
  reset();
  pendingBook = [{ tpPrice: 11000, slPrice: 9990 }];
  livePos = [mkPos({ qty: 0.1, unrealizedPNL: 100, markPrice: 10000, leverage: 4, liqPrice: 9990 })];
  setCentre(10000);
  writes = [];
  const tight = await pass();
  const tightMove = tight.actions.find((a) => a.type === 'stop_moved');
  assert(tightMove !== undefined, 'the stop was moved');
  if (tightMove) {
    assert(Math.abs(tightMove.stop - 10008) < 1e-9,
      `profit-side stop NOT rewritten (SL ${tightMove.stop}, old bug gave 9995)`);
    assert(!String(tightMove.reason).includes('clamped'),
      `no clamp note in the reason ("${tightMove.reason}")`);
    assert(tightMove.stop > 9990, `and it still sits inside liquidation (${tightMove.stop} > liq 9990)`);
  }

  console.log('\nA SHORT mirrors all of it');
  // notional 0.01 x 10000 = 100, pnl 100 -> 1000% ROI. A short's stop must go
  // BELOW entry, and the trailing stop above the market.
  pendingBook = [{ tpPrice: 9000, slPrice: 10100 }];
  livePos = [mkPos({ side: 'SHORT', unrealizedPNL: 100, markPrice: 9000, liqPrice: 11000 })];
  reset();
  writes = [];
  const shorted = await pass();
  const shortMove = shorted.actions.find((a) => a.type === 'stop_moved');
  assert(shortMove !== undefined, 'the short position moved its stop too');
  if (shortMove) {
    assert(shortMove.stop < 10000, `a SHORT stop locks in below entry (${shortMove.stop} < 10000)`);
    assert(shortMove.stop > 9000, `but above the market, so it is a stop (${shortMove.stop} > 9000)`);
  }

  console.log('\nAn unreachable exchange is a no-op, never a wrong action');
  bitunix.getPendingPositions = async () => { throw new Error('exchange unreachable'); };
  const degraded = await pass();
  assert(degraded.degraded !== undefined, 'the failure is reported, not swallowed');
  assert(String(degraded.degraded).includes('exchange unreachable'), 'with the reason intact');
  assert(degraded.actions.length === 0, 'and no position was acted on');

  console.log('\nAn empty book is a clean no-op');
  install();
  livePos = [];
  const flat = await pass();
  assert(flat.positions.length === 0, 'no positions');
  assert(flat.actions.length === 0, 'no actions');

  console.log('\nSeveral positions are each managed independently');
  pendingBook = [{ tpPrice: 11000, slPrice: 9900 }];
  livePos = [
    mkPos({ positionId: '1', symbol: 'BTCUSDT', unrealizedPNL: 100, markPrice: 11000 }),
    mkPos({ positionId: '2', symbol: 'ETHUSDT', unrealizedPNL: -20, markPrice: 1980 }),
    mkPos({ positionId: '3', symbol: 'SOLUSDT', side: 'SHORT', unrealizedPNL: 50, markPrice: 140 }),
  ];
  reset();
  writes = [];
  const book = await pass();
  assert(book.positions.length === 3, 'all three came back');
  const movedSyms = book.actions.filter((a) => a.type === 'stop_moved').map((a) => a.symbol);
  assert(!movedSyms.includes('ETHUSDT'), 'the losing ETH position was left alone');
  assert(movedSyms.includes('BTCUSDT'), 'the winning BTC position was trailed');

  console.log('\npositionRoi is what the loop reads, and it is the fixed one');
  assert(close(positionRoi(mkPos({ unrealizedPNL: 100 })), 1000),
    'the fixed formula, confirmed independently of the loop');

  resetSymbolConfigCache();
  console.log(`\npassed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

test().catch((e) => { console.error(e); process.exit(1); });
