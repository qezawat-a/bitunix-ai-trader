/**
 * Error-code table + order-status conformance, cross-checked against the
 * official docs:
 *   https://www.bitunix.com/api-docs/futures/ErrorCode/error_code.html
 *   https://www.bitunix.com/api-docs/futures/trade/get_history_orders.html  (status enum)
 *
 * The shipped table used to carry several wrong/duplicate meanings (e.g. it
 * mapped 30005 to "cannot change position mode" and 40001 to "internal server
 * error"), and its retryable set wrongly auto-retried the deterministic 40001
 * lead-trading precondition while missing the transient 40007. These pin the
 * corrected values so a future edit cannot silently drift from the docs again.
 */

import { BITUNIX_ERRORS, BitunixError, ORDER_STATUS, orderGotFill, orderIsTerminal, orderRejected } from '../src/exchange/errors.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

console.log('=== error table matches the official docs ===\n');

console.log('codes that used to be wrong are now correct');
assert(BITUNIX_ERRORS[20005] === 'Invalid leverage', `20005 = "Invalid leverage" (got "${BITUNIX_ERRORS[20005]}")`);
assert(BITUNIX_ERRORS[20006] === "You can't change leverage or margin mode as there are open orders", `20006 = can't change leverage/margin mode (got "${BITUNIX_ERRORS[20006]}")`);
assert(BITUNIX_ERRORS[20007] === 'Order not found, please try it later', `20007 = order not found (got "${BITUNIX_ERRORS[20007]}")`);
assert(BITUNIX_ERRORS[20009] === 'Position exists, so positions mode cannot be updated', `20009 = position mode cannot be updated (got "${BITUNIX_ERRORS[20009]}")`);
assert(BITUNIX_ERRORS[20004] === 'Insufficient Trader', `20004 = "Insufficient Trader" (got "${BITUNIX_ERRORS[20004]}")`);
assert(BITUNIX_ERRORS[30004] === 'Position not exist', `30004 = "Position not exist" (got "${BITUNIX_ERRORS[30004]}")`);
assert(BITUNIX_ERRORS[30005] === 'The trigger price is closer to the current price and may be triggered immediately', `30005 = trigger price too close (got "${BITUNIX_ERRORS[30005]}")`);
assert(BITUNIX_ERRORS[30017] === 'The qty cannot be less than the minimum qty', `30017 = qty below minimum (got "${BITUNIX_ERRORS[30017]}")`);
assert(BITUNIX_ERRORS[30042] === 'Client ID duplicate', `30042 = client ID duplicate (got "${BITUNIX_ERRORS[30042]}")`);
assert(BITUNIX_ERRORS[40001] === 'Please cancel open orders and close all positions before canceling lead trading', `40001 = lead-trading precondition, NOT internal error (got "${BITUNIX_ERRORS[40001]}")`);

console.log('\nfabricated codes are gone');
assert(BITUNIX_ERRORS[10009] === undefined, '10009 no longer fabricated as "Account not found"');
assert(BITUNIX_ERRORS[10012] === undefined, '10012 no longer fabricated as "Account does not exist"');

console.log('\nthe transient "settlement in progress" code is present');
assert(BITUNIX_ERRORS[40007] === 'Share settlement is being processed,lease try again later', `40007 present (got "${BITUNIX_ERRORS[40007]}")`);
assert(BITUNIX_ERRORS[403] === 'This API key does not support this operation', '403 present');

console.log('\nretryable set is TRANSIENT-only');
const transient = [10001, 10005, 10006, 40007];
const deterministic = [40001, 10007, 20003, 20006, 30001];
for (const c of transient) assert(new BitunixError(c, 'x').retryable === true, `${c} is retryable`);
for (const c of deterministic) assert(new BitunixError(c, 'x').retryable === false, `${c} is NOT retried (deterministic)`);

console.log('\norder status enum includes EXPIRED (documented history-filter status)');
assert(ORDER_STATUS.EXPIRED === 'EXPIRED', 'EXPIRED is a known status');
assert(orderIsTerminal('EXPIRED') === true, 'EXPIRED is terminal');
assert(orderRejected('EXPIRED') === true, 'EXPIRED counts as nothing-filled (aborts booking)');
assert(orderGotFill('EXPIRED') === false, 'EXPIRED did not fill anything');
assert(orderRejected('CANCELED') === true, 'CANCELED still aborts booking');
assert(orderGotFill('PART_FILLED_CANCELED') === true, 'PART_FILLED_CANCELED still counts as a (partial) fill');

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
