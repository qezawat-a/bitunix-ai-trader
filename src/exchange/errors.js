/**
 * Bitunix error codes — from
 * https://www.bitunix.com/api-docs/futures/ErrorCode/error_code.html
 * Used to give the agent human-readable failure reasons instead of raw codes.
 */
export const BITUNIX_ERRORS = {
  0: 'Success',
  403: 'This API key does not support this operation',
  10001: 'Network Error',
  10002: 'Parameter Error',
  10003: "api-key can't be empty",
  10004: 'The current ip is not in the apikey ip whitelist',
  10005: 'Too many requests, please try again later',
  10006: 'Request too frequently',
  10007: 'Sign signature error',
  10008: '{value} does not comply with the rule, optional [correctValue]',
  10010: "Nonce's length must be less than 64",
  10011: 'The request timestamp must be within 60,000 ms of the server time.',
  20001: 'Market not exists',
  20002: 'The current positions amount has exceeded the maximum open limit, please adjust the risk limit',
  20003: 'Insufficient balance',
  20004: 'Insufficient Trader',
  20005: 'Invalid leverage',
  20006: "You can't change leverage or margin mode as there are open orders",
  20007: 'Order not found, please try it later',
  20008: 'Insufficient amount',
  20009: 'Position exists, so positions mode cannot be updated',
  20010: 'Activation failed, the available balance in the futures account does not meet the conditions for activation of the coupon',
  20011: 'Account not allowed to trade',
  20012: 'This futures does not allow trading',
  20013: 'Function disabled due tp pending account deletion request',
  20014: 'Account deleted',
  20015: 'This futures is not supported',
  20016: 'Batch order exceeded the max size',
  30001: 'Failed to order. Please adjust the order price or the leverage as the order price dealt may immediately liquidate.',
  30002: 'Price below liquidated price',
  30003: 'Price above liquidated price',
  30004: 'Position not exist',
  30005: 'The trigger price is closer to the current price and may be triggered immediately',
  30006: 'Please select TP or SL',
  30007: 'TP trigger price is greater than average entry price',
  30008: 'TP trigger price is less than average entry price',
  30009: 'SL trigger price is less than average entry price',
  30010: 'SL trigger price is greater than average entry price',
  30011: 'Abnormal order status',
  30012: 'Already added to favorite',
  30013: 'Exceeded the maximum order quantity',
  30014: 'Max Buy Order Price',
  30015: 'Mini Sell Order Price',
  30016: 'The qty should be larger than',
  30017: 'The qty cannot be less than the minimum qty',
  30018: 'Order failed. No position opened. Cancel [Reduce-only] settings and retry later',
  30019: 'Order failed. A [Reduce-only] order can not be in the same direction as the open position',
  30020: 'Trigger price for TP should be higher than mark price:',
  30021: 'Trigger price for TP should be lower than mark price:',
  30022: 'Trigger price for SL should be higher than mark price:',
  30023: 'Trigger price fo SL should be lower than mark price:',
  30024: 'Trigger price for SL should be lower than liq price:',
  30025: 'Trigger price for SL should be higher than liq price:',
  30026: 'TP price must be greater than last price:',
  30027: 'TP price must be greater than mark price:',
  30028: 'SL price must be less than last price:',
  30029: 'SL price must be less than mark price:',
  30030: 'SL price must be greater than last price:',
  30031: 'SL price must be greater than mark price:',
  30032: 'TP price must be less than last price:',
  30033: 'TP price must be less than mark price:',
  30034: 'TP price must be less than mark price:',
  30035: 'SL price must be greater than trigger price:',
  30036: 'TP price must be greater than trigger price:',
  30037: 'TP price must be greater than trigger price:',
  30038: 'TP/SL amount must be less than the size of the position.',
  30039: "The order qty can't be greater than the max order qty:",
  30040: 'Futures trading is prohibited, please contact customer service.',
  30041: 'Trigger price must be greater than 0',
  30042: 'Client ID duplicate',
  40001: 'Please cancel open orders and close all positions before canceling lead trading',
  40002: 'Lead amount hast to be over the limits',
  40003: 'Lead order amount exceeds the limits.',
  40004: 'Please do not repeat the operation',
  40005: 'Action is not available for the current user type.',
  40006: 'Sub-account reaches the limit.',
  40007: 'Share settlement is being processed,lease try again later',
  40008: 'After the transfer, the account balance will be less than the order amount, please enter again.',
};

export class BitunixError extends Error {
  constructor(code, msg, context = {}) {
    const known = BITUNIX_ERRORS[code];
    super(`Bitunix ${code}: ${msg || known || 'Unknown error'}${known && known !== msg ? ` (${known})` : ''}`);
    this.name = 'BitunixError';
    this.code = Number(code);
    this.apiMessage = msg;
    this.context = context;
  }

  /**
   * Errors worth retrying automatically — genuinely TRANSIENT conditions only.
   * A deterministic business-rule rejection must never be blind-retried: the
   * _request loop would re-POST a live write the exchange already refused.
   *   10001 network, 10005/10006 rate-limit, 40007 "settlement in progress".
   * 40001 is deliberately NOT here: it is the copy-trading precondition
   * "cancel open orders and close all positions before canceling lead trading".
   */
  get retryable() {
    return [10001, 10005, 10006, 40007].includes(this.code);
  }
}

export function describeError(code, msg) {
  return BITUNIX_ERRORS[Number(code)] || msg || `Unknown error ${code}`;
}

/**
 * Order statuses, from the SDK's OrderStatus enum.
 *
 * PART_FILLED_CANCELED is the one that bites: the order filled some quantity
 * and the rest was cancelled. It is neither "filled" nor "cancelled" in the
 * naive sense — there IS a position, just smaller than requested — so code
 * that branches on FILLED alone silently mis-sizes.
 */
export const ORDER_STATUS = {
  INIT: 'INIT',
  NEW: 'NEW',
  PART_FILLED: 'PART_FILLED',
  PART_FILLED_CANCELED: 'PART_FILLED_CANCELED',
  CANCELED: 'CANCELED',
  FILLED: 'FILLED',
  EXPIRED: 'EXPIRED',
};

/** Did this order put anything on the book? */
export function orderGotFill(status) {
  return ['PART_FILLED', 'PART_FILLED_CANCELED', 'FILLED'].includes(String(status).toUpperCase());
}

/** Is the order finished, one way or another? */
export function orderIsTerminal(status) {
  return ['FILLED', 'CANCELED', 'PART_FILLED_CANCELED', 'EXPIRED'].includes(String(status).toUpperCase());
}

/**
 * Finished with nothing filled — the trade never happened.
 *
 * EXPIRED (an IOC/FOK that never filled) carries no position, exactly like a
 * CANCELED market order, so both abort the booking path rather than let the
 * caller assume a full fill. EXPIRED is a documented status on the history
 * filter (get_history_orders: FILLED, CANCELED, PART_FILLED_CANCELED, EXPIRED).
 */
export function orderRejected(status) {
  return ['CANCELED', 'EXPIRED'].includes(String(status).toUpperCase());
}
