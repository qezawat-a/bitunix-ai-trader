/**
 * Exercise the REAL sizeOrder() / describeUnits() from src/exchange/bitunix.js.
 *
 * Formulas are the Bitunix help-centre ones (article id=170):
 *   NOMINAL  qty = nominal / price
 *   COST     qty = cost * leverage / price
 *   QTY      cost = qty * price / leverage
 *
 * sizeOrder() reaches the network only through roundQty -> pairInfo, so that
 * one method is stubbed with a fixed precision/minimum. Everything else is the
 * shipped code path.
 */

import { BitunixClient } from '../src/exchange/bitunix.js';

const client = new BitunixClient();
const PREC = 4;
const MIN_QTY = 0.001;
client.pairInfo = async () => ({ basePrecision: PREC, minTradeVolume: MIN_QTY, quotePrecision: 2 });

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const size = (unit, amount, leverage, price, symbol = 'BTCUSDT') =>
  client.sizeOrder({ symbol, unit, amount, leverage, price });

async function test() {
  console.log('=== Order unit calculator (real bitunix.js) ===\n');

  console.log('The three units describe the same position three ways');
  // 1000 USDT nominal at 10x, price 10000  ->  100 margin, 0.1 BTC
  const nominal = await size('NOMINAL', 1000, 10, 10000);
  assert(close(Number(nominal.qty), 0.1), `NOMINAL 1000 @10x 10000 -> qty ${nominal.qty} (0.1)`);
  assert(close(nominal.cost, 100), `  margin ${nominal.cost.toFixed(4)} (100 = 1000/10)`);
  assert(close(nominal.nominal, 1000), `  nominal ${nominal.nominal.toFixed(4)} (1000)`);

  const cost = await size('COST', 100, 10, 10000);
  assert(close(Number(cost.qty), 0.1), `COST 100 @10x 10000 -> qty ${cost.qty} (0.1)`);
  assert(close(cost.cost, 100), `  margin ${cost.cost.toFixed(4)} (100)`);
  assert(close(cost.nominal, 1000), `  nominal ${cost.nominal.toFixed(4)} (1000)`);

  const qty = await size('QTY', 0.1, 10, 10000);
  assert(close(Number(qty.qty), 0.1), `QTY 0.1 @10x 10000 -> qty ${qty.qty} (0.1)`);
  assert(close(qty.nominal, 1000), `  nominal ${qty.nominal.toFixed(4)} (1000)`);
  assert(close(qty.cost, 100), `  margin ${qty.cost.toFixed(4)} (100)`);

  console.log('\nAll three inputs round-trip to one identical position');
  const viaNominal = await size('NOMINAL', 1000, 10, 10000);
  const viaCost = await size('COST', 1000 / 10, 10, 10000);
  const viaQty = await size('QTY', 1000 / 10000, 10, 10000);
  assert(viaNominal.qty === viaCost.qty && viaCost.qty === viaQty.qty,
    `same qty from every unit: ${viaNominal.qty} / ${viaCost.qty} / ${viaQty.qty}`);

  console.log('\nLeverage is the bridge between cost and nominal');
  for (const lev of [1, 3, 5, 20, 50, 125]) {
    const r = await size('COST', 500, lev, 50000, 'BTCUSDT');
    assert(close(r.nominal, 500 * lev, 1e-6), `${lev}x: nominal = cost x lev = ${r.nominal.toFixed(2)}`);
    assert(close(Number(r.qty), (500 * lev) / 50000, 1e-4), `${lev}x: qty = ${r.qty}`);
  }

  console.log('\nEvery unit is convertible into the other two');
  const start = await size('COST', 250, 8, 3200, 'ETHUSDT');
  const asNominal = await size('NOMINAL', start.nominal, 8, 3200, 'ETHUSDT');
  const asQty = await size('QTY', Number(start.qty), 8, 3200, 'ETHUSDT');
  assert(asNominal.qty === start.qty, `COST -> NOMINAL keeps qty ${asNominal.qty}`);
  assert(asQty.qty === start.qty, `COST -> QTY keeps qty ${asQty.qty}`);

  console.log('\nRounding reports what the ROUNDED qty actually costs');
  // 100 USDT margin at 10x on a 50123.45 pair is 0.019934... -> truncated to
  // 0.0199. That is materially less than the 100 asked for, so cost/nominal
  // must follow the truncated qty, and requested* must expose the gap.
  const rough = await size('COST', 100, 10, 50123.45);
  assert(rough.qty === '0.0199', `qty truncated to ${rough.qty} (raw 0.01993...)`);
  assert(Number(rough.qty) < 100 * 10 / 50123.45, 'truncation only ever removes size');
  assert(close(rough.cost, Number(rough.qty) * 50123.45 / 10), 'cost follows the rounded qty');
  assert(close(rough.requestedCost, 100), 'requestedCost preserves what you asked for');
  assert(rough.cost < rough.requestedCost, `real cost ${rough.cost.toFixed(4)} < requested ${rough.requestedCost}`);

  console.log('\nMinimum trade size is enforced, not silently violated');
  const dust = await size('COST', 1, 10, 50000, 'BTCUSDT');
  assert(dust.qty === MIN_QTY.toFixed(PREC), `1 USDT of margin -> bumped to the ${dust.qty} minimum`);
  assert(close(dust.cost, Number(MIN_QTY) * 50000 / 10),
    `and its true cost is reported as ${dust.cost.toFixed(2)}, not the 1 asked for`);

  console.log('\nInput validation');
  for (const bad of [
    { amount: 0 }, { amount: -5 }, { amount: 'abc' }, { leverage: 0 }, { price: 0 },
  ]) {
    let threw = false;
    try { await size('COST', bad.amount ?? 100, bad.leverage ?? 10, bad.price ?? 10000); }
    catch { threw = true; }
    assert(threw, `rejects ${JSON.stringify(bad)}`);
  }
  let badUnit = false;
  try { await size('BANANA', 100, 10, 10000); } catch { badUnit = true; }
  assert(badUnit, 'rejects an unknown unit');

  console.log('\ndescribeUnits() matches the help-centre article');
  const desc = client.describeUnits();
  for (const t of ['COST', 'NOMINAL', 'QTY']) assert(desc.includes(t), `explains ${t}`);
  assert(/nominal ÷ price/.test(desc), 'states qty = nominal / price');
  assert(/cost × leverage ÷ price/.test(desc), 'states qty = cost x leverage / price');
  assert(desc.includes('base coin'), 'notes the exchange only takes base coin');

  console.log(`\npassed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

test().catch((e) => { console.error(e); process.exit(1); });