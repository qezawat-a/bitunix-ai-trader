import crypto from 'node:crypto';

/**
 * Bitunix signature — implemented EXACTLY as documented in
 * https://www.bitunix.com/api-docs/futures/common/sign.html
 *
 *   digest = SHA256( nonce + timestamp + api-key + queryParams + body )
 *   sign   = SHA256( digest + secretKey )
 *
 * queryParams : all query keys sorted ASC by ASCII, concatenated as key+value,
 *               with NO separators and NO spaces.  e.g. {uid:200,id:1} -> "id1uid200"
 * body        : the raw JSON body string exactly as it is sent on the wire
 *               (compact, no spaces). Empty string when there is no body.
 * timestamp   : current timestamp in milliseconds (string)
 * nonce       : random 32-char string
 */

export const sha256Hex = (input) =>
  crypto.createHash('sha256').update(input, 'utf8').digest('hex');

export const makeNonce = () => crypto.randomBytes(16).toString('hex'); // 32 chars

/** Sorted ASCII key+value concatenation of query params (no separators). */
export function buildQueryParamsString(params = {}) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}${v}`).join('');
}

/** Standard URL query string, using the same sorted order used for signing. */
export function buildQueryString(params = {}) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** REST signature headers. */
export function signRest({ apiKey, secretKey, queryParams = {}, bodyString = '' }) {
  const nonce = makeNonce();
  const timestamp = String(Date.now());
  const qp = buildQueryParamsString(queryParams);
  const digest = sha256Hex(nonce + timestamp + apiKey + qp + bodyString);
  const sign = sha256Hex(digest + secretKey);
  return {
    'api-key': apiKey,
    sign,
    nonce,
    timestamp,
    language: 'en-US',
    'Content-Type': 'application/json',
  };
}

/**
 * WebSocket login signature (private channel):
 *   digest = SHA256( nonce + timestamp + apiKey )
 *   sign   = SHA256( digest + secretKey )
 * timestamp is SECONDS here (per WebSocket doc).
 */
export function signWs({ apiKey, secretKey }) {
  const nonce = makeNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = sha256Hex(`${nonce}${timestamp}${apiKey}`);
  const sign = sha256Hex(`${digest}${secretKey}`);
  return { apiKey, timestamp, nonce, sign };
}
