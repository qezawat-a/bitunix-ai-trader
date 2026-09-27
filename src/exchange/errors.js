/**
 * Bitunix error codes — from
 * https://www.bitunix.com/api-docs/futures/ErrorCode/error_code.html
 * Used to give the agent human-readable failure reasons instead of raw codes.
 */
export const BITUNIX_ERRORS = {
  0: 'Success',
  10001: 'Network error',
  10002: 'Parameter error',
  10003: 'api-key cannot be empty',
  10004: 'The current ip is not in the apikey ip whitelist',
  10005: 'Too many requests, please try again later',
  10006: 'Request too frequent',
  10007: 'Sign signature error',
  10008: 'Exceeds maximum quantity limit',
  10009: 'Account not found',
  10010: 'Duplicate clientId',
  10011: 'Account already exists',
  10012: 'Account does not exist',
  20001: 'Market not exists',
  20002: 'The current positions amount has exceeded the maximum open limit',
  20003: 'Insufficient balance',
  20004: 'Insufficient margin',
  20005: 'Position not exist',
  20006: 'Order not exist',
  20007: 'Order price or quantity precision error',
  20008: 'Insufficient amount',
  20009: 'Position exists, cannot modify',
  20010: 'Activation failed, insufficient margin',
  20011: 'Liquidation price error',
  20012: 'Order quantity below minimum',
  20013: 'Trigger price error',
  20014: 'Illegal parameter',
  20015: 'Order status error',
  30001: 'Trading pair not supported / trading disabled',
  30002: 'Price exceeds the price protection scope',
  30003: 'Leverage exceeds allowed tier',
  30004: 'Cannot change margin mode with open position or open order',
  30005: 'Cannot change position mode with open position or open order',
  30036: 'Duplicate TP/SL order for this position',
  40001: 'Internal server error',
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

  /** Errors that are worth retrying automatically. */
  get retryable() {
    return [10001, 10005, 10006, 40001].includes(this.code);
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
};

/** Did this order put anything on the book? */
export function orderGotFill(status) {
  return ['PART_FILLED', 'PART_FILLED_CANCELED', 'FILLED'].includes(String(status).toUpperCase());
}

/** Is the order finished, one way or another? */
export function orderIsTerminal(status) {
  return ['FILLED', 'CANCELED', 'PART_FILLED_CANCELED'].includes(String(status).toUpperCase());
}

/** Finished with nothing filled — the trade never happened. */
export function orderRejected(status) {
  return String(status).toUpperCase() === 'CANCELED';
}
