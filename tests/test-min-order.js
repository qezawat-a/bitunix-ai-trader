import { minOrderNotional, minMarginForMinOrder } from '../src/trading/risk.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log('=== minimum order floor calculator ===');

console.log('minTradeVolume is base coins; notional = qty x price');
// IRYSUSDT-style: minTradeVolume 0.0094 base, price 1000 USD
const notional = minOrderNotional({ price: 1000, minTradeVolume: 0.0094 });
assert(close(notional, 9.4), `min notional ${notional.toFixed(4)} (got 9.4)`);

console.log('A 5-decimal minTradeVolume is rounded UP to the 4-digit precision so the order never slips below min');
const upNominal = minOrderNotional({ price: 1000, minTradeVolume: 0.00944, precision: 4 });
assert(close(upNominal, 9.5), `rounded up min notional ${upNominal.toFixed(4)} (got 9.5)`);

console.log('min margin shrinks with leverage but never below the minimum order');
const mm5 = minMarginForMinOrder({ price: 1000, minTradeVolume: 0.0094, leverage: 5 });
assert(close(mm5, 1.88), `min margin at 5x ${mm5.toFixed(4)} (got 1.88)`);

const mm20 = minMarginForMinOrder({ price: 1000, minTradeVolume: 0.0094, leverage: 20 });
assert(close(mm20, 0.47), `min margin at 20x ${mm20.toFixed(4)} (got 0.47)`);

console.log('Scenario: $2.00 balance, IRYS min order 9.4 USDT, stop 8.8% of price');
// leverage ceiling from the ATR stop (~5x with a 0.5 liquidity buffer)
const available = 2.0;
const minMargin = minMarginForMinOrder({ price: 1000, minTradeVolume: 0.0094, leverage: 5 });
const feasible = (minOrderNotional({ price: 1000, minTradeVolume: 0.0094 }) / available) <= 5;
assert(feasible, 'minimum order fits within the balance at a safe leverage');
assert(close(minMargin, 1.88), `margin needed ${minMargin.toFixed(2)} <= 2.00 available`);
assert(close(1.88 * 5 / 1000, 0.0094), `qty clears minTradeVolume (${minMargin * 5 / 1000})`);

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
