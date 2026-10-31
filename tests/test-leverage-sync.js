/**
 * openFromSignal's liquidation-aware sizing must keep the exchange's HELD
 * leverage in agreement with the leverage the order is actually sized at.
 *
 * BUG (measured live on BEAMXUSDT, 2026-10-26): the ATR-stop liquidation
 * ceiling clamped only the LOCAL sizing leverage (40x) while
 * ensureSymbolConfig() had left the exchange holding the configured 50x.
 * The position opened at 50x while the fill message, the trade record and
 * the margin math all claimed 40x ("margin 0.08 USDT · 40x" against an
 * exchange position the UI showed as 50x), and the real ATR stop sat almost
 * on top of the liquidation price the ceiling was computed to avoid.
 *
 * What must hold now:
 *   - sized-at leverage  == exchange-held leverage (verified by read-back)
 *   - the exchange is ASKED to hold the safe value when it differs
 *   - a request the exchange refuses is a refused TRADE, not a mis-sized one
 */
import bitunix from '../src/exchange/bitunix.js';
import { pool, setSetting } from '../src/db/index.js';
import { openFromSignal, resetSymbolConfigCache } from '../src/trading/executor.js';

// openTrade() has no degraded fallback, and this box leaks a DATABASE_URL
// that points at a database that is not running. The suite must be hermetic,
// so the pool is muted in place (property assignment on the exported object —
// ESM exports stay importable, they are just no longer consulted for real).
pool.query = async () => ({ rows: [{ id: 123 }] });

/**
 * setSetting() persists through q() and then RELOADS settings on success. A
 * blanket pool stub would answer the reload with garbage and silently wipe
 * what was seeded (the settings cache is rebuilt as defaults + DB rows), so
 * the stub keeps just enough state to be a real, honest in-memory store.
 */
const seeded = {};
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
  return { rows: [{ id: 123 }] };
};

// Seed the settings this suite cares about (schema-validated, memory store).
await setSetting('leverage', 50, 'test');
await setSetting('margin_pct', 5, 'test');
await setSetting('margin_mode', 'CROSS', 'test');
await setSetting('position_mode', 'HEDGE', 'test');
await setSetting('order_unit', 'COST', 'test');

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/**
 * A BEAM-shaped signal: the 3m ATR is fat enough that, at the tier's MMR of
 * 0.5%, the ATR stop only survives liquidation up to ~41x — below the
 * configured 50x. timeframes[0] is the execution TF (1m), and the stop is
 * sized off the first STRUCTURE TF (3m), exactly as scanner + risk do.
 */
const mkSignal = (threeMinAtr) => ({
  symbol: 'BEAMUSDT', side: 'LONG',
  confidence: 72, rawConfidence: 72, agreement: 4,
  regime: 'RANGE', htfRegime: 'TREND_UP', adx: 0, atrExpansion: 1,
  price: 0.003319, atr: 0.000012, atrPct: 0.36,
  donHigh: 0.0034, donLow: 0.0032, funding: 0.01,
  timeframes: { '1m': { atr: 0.000012 }, '3m': { atr: threeMinAtr ?? 0.000024 } },
  strategies: [{ name: 'trend', confidence: 72, timeframes: ['1m', '3m'] }],
  opposite: { side: 'SHORT', agreement: 0, confidence: 0 },
  flags: [],
});

let calls = [];

function install({ heldLev = 50, changeRefuses = false } = {}) {
  resetSymbolConfigCache();
  calls = [];

  bitunix.getAccount = async () => [{
    available: 10, margin: 0, frozen: 0, bonus: 0,
    positionMode: 'HEDGE', crossUnrealizedPNL: 0,
  }];
  // One unrelated position elsewhere: passes the count/all-ready-in gates.
  bitunix.getPendingPositions = async () => [
    { positionId: 'P9', symbol: 'ETHUSDT', side: 'LONG', qty: 1 },
  ];
  bitunix.changePositionMode = async (m) => { calls.push(['positionMode', m]); return { ok: true }; };
  bitunix.changeMarginMode = async (b) => { calls.push(['changeMarginMode', b.marginMode]); return { ok: true }; };
  bitunix.getLeverageAndMarginMode = async (symbol) => {
    calls.push(['readLev', symbol]);
    return { symbol, marginCoin: 'USDT', leverage: heldLev, marginMode: 'ISOLATION' };
  };
  bitunix.changeLeverage = async ({ symbol, leverage }) => {
    calls.push(['changeLev', symbol, leverage]);
    if (changeRefuses) throw new Error('Bitunix 20005: Invalid leverage');
    // Documented response shape (change_leverage): data is a list of rows
    // carrying the APPLIED leverage — the first thing sync must trust.
    return [{ marginCoin: 'USDT', leverage, symbol }];
  };
  bitunix.getTickers = async () => [{ markPrice: 0.003319, lastPrice: 0.003319 }];
  bitunix.pairInfo = async () => ({
    symbol: 'BEAMUSDT', basePrecision: 4, quotePrecision: 8,
    minTradeVolume: 0.5, maxMarketOrderVolume: 1e9,
    maxLeverage: 125, minLeverage: 1, symbolStatus: 'OPEN', isApiSupported: true,
  });
  bitunix.tierFor = async () => ({ mmr: 0.005, level: 1, startValue: 0, endValue: 100000 });
  bitunix.roundPrice = async (s, px) => Number(px).toFixed(8);
  bitunix.roundQty = async (s, q) => Number(q).toFixed(4);
  bitunix.placeOrder = async (body) => {
    calls.push(['placeOrder', body.qty, body.slPrice, body.tpPrice]);
    return { orderId: 'o-1' };
  };
  bitunix.getOrderDetail = async () => [{ status: 'FILLED', tradeQty: 0 }];
  bitunix.getHistoryPositions = async () => ({ positionList: [] });
}

console.log('=== openFromSignal keeps sizing leverage and held leverage in agreement ===\n');

console.log('no clamp needed -> the exchange is never even touched on leverage');
install({ heldLev: 50 });
// 3m ATR 0.000006 -> slDist ~7.9E-6 -> liquidation-safe up to ~102x; the
// configured 50x is inside the ceiling, so no change_leverage at all.
const calm = await openFromSignal(mkSignal(0.000006));
assert(calm.ok === true, `opened (${calm.reason || ''})`);
assert(calm.leverage === 50, `sized at the held 50x (got ${calm.leverage})`);
assert(calm.leverageAdjusted === false, 'no adjustment was announced');
assert(!calls.some((c) => c[0] === 'changeLev'), 'change_leverage was never called');
assert(calls.some((c) => c[0] === 'placeOrder'), 'the order was placed');

console.log('\nthe ceiling fires -> the exchange is MOVED to the safe value first');
install({ heldLev: 50 });
// 3m ATR 0.000024 -> slDist ~3.2E-5 -> the stop only survives up to ~41x < 50x.
const moved = await openFromSignal(mkSignal(0.000024));
assert(moved.ok === true, `opened (${moved.reason || ''})`);
assert(moved.leverage === 41, `sized AND held at the verified 41x (got ${moved.leverage})`);
assert(moved.leverageAdjusted === true, 'the adjustment is announced');
assert(String(moved.leverageAdjustmentReason || '').includes('applied 41x'),
  `the reason says the value was applied (${moved.leverageAdjustmentReason})`);
const lev = calls.find((c) => c[0] === 'changeLev');
assert(lev && lev[2] === 41, `change_leverage was asked for 41x (${calls.filter((c) => c[0] === 'changeLev')})`);
// The write must be ORDERED: leverage is on the exchange BEFORE sizing.
const levIdx = calls.findIndex((c) => c[0] === 'changeLev');
const ordIdx = calls.findIndex((c) => c[0] === 'placeOrder');
assert(levIdx !== -1 && ordIdx > levIdx, `change_leverage precedes place_order (${calls.map((c) => c[0]).join(',')})`);
// Sizing math must reflect the applied leverage: qty = cost x lev / price.
const placed = calls.find((c) => c[0] === 'placeOrder');
assert(close(Number(placed[1]), 0.5 * 41 / 0.003319, 1e-2),
  `qty sized at 41x (got ${placed[1]})`);

console.log('\nthe exchange refuses the safe value -> the TRADE is refused');
install({ heldLev: 50, changeRefuses: true });
const refused = await openFromSignal(mkSignal(0.000024));
assert(refused.ok === false, 'no position opened on an unverifiable leverage');
assert(/holds 50/.test(refused.reason) && /41/.test(refused.reason),
  `the refusal names both leverages (${refused.reason})`);
assert(!calls.some((c) => c[0] === 'placeOrder'), 'no order was placed against a book the exchange refuses to de-lever');

console.log('\nthe read-back differs from the request -> also refused');
install({ heldLev: 50 });
// The exchange accepts the REQUEST but clamps what it HOLDS back to 50 — the
// doc's response row carries the APPLIED value, and that is what must win.
bitunix.changeLeverage = async ({ symbol }) => {
  calls.push(['changeLev', symbol, 50]);
  return [{ marginCoin: 'USDT', leverage: 50, symbol }];   // clamped back
};
const clampedBack = await openFromSignal(mkSignal(0.000024));
assert(clampedBack.ok === false, `refused when the exchange cannot hold the safe value (${clampedBack.reason || ''})`);

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
