/**
 * Signing regression test, cross-checked against the OFFICIAL Bitunix demo.
 *
 * The reference implementation lives in examples/bitunix-open-api-node/
 * (openApiHttpSign.js / openApiWsSign.js, from the official open-api Demo
 * repository). Given identical inputs, our signing code must produce the
 * exact same signature the official demo produces — otherwise every
 * authenticated request fails with code 10007.
 *
 * Two layers of checking:
 *   1. deterministic vectors: known input -> known SHA256 chain, computed
 *      here with raw node:crypto string concatenations (independent of
 *      either implementation's helpers),
 *   2. direct comparison with the demo modules for the same inputs.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  sha256Hex, makeNonce, buildQueryParamsString, buildQueryString,
  signRest, signRestCore, signWs, signWsCore,
} from '../src/exchange/sign.js';

const require = createRequire(import.meta.url);
const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'bitunix-open-api-node');
const DemoHttpSign = require(join(demoDir, 'openApiHttpSign.js'));
const demoWsSign = require(join(demoDir, 'openApiWsSign.js'));

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

const NONCE = 'deadbeef'.repeat(4);            // 32 chars, like makeNonce()
const TS_MS = '1750000000000';
const TS_S = 1750000000;
const KEY = 'apiKeyTest123';
const SECRET = 'secretTest456';
const PARAMS = { symbol: 'BTCUSDT', limit: 100, symbols: 'BTCUSDT,ETHUSDT' };
const BODY = '{"side":"BUY","qty":"0.1","orderType":"MARKET"}';

function test() {
  console.log('=== Signing vs the official Bitunix demo ===\n');

  console.log('deterministic vectors (raw SHA256 chain, independent of both implementations)');
  const qpSorted = 'limit100symbolBTCUSDTsymbolsBTCUSDT,ETHUSDT'; // ASCII key order
  assert(buildQueryParamsString(PARAMS) === qpSorted, `buildQueryParamsString matches ${qpSorted}`);
  const digest = crypto.createHash('sha256').update(NONCE + TS_MS + KEY + qpSorted + BODY).digest('hex');
  const expectedSign = crypto.createHash('sha256').update(digest + SECRET).digest('hex');
  const headers = signRestCore({ apiKey: KEY, secretKey: SECRET, queryParams: PARAMS, bodyString: BODY, nonce: NONCE, timestamp: TS_MS });
  assert(headers.sign === expectedSign, 'REST sign equals the documented SHA256(SHA256(nonce+ts+key+qp+body)+secret)');
  assert(headers.nonce === NONCE && headers.timestamp === TS_MS, 'nonce/timestamp passed through');
  assert(headers['api-key'] === KEY && headers.language === 'en-US', 'header shape (api-key, language)');

  console.log('\nexact match against the official demo modules');
  const demoSign = DemoHttpSign.generateSignature(KEY, SECRET, NONCE, TS_MS, DemoHttpSign.sortParams(PARAMS), BODY);
  assert(demoSign === expectedSign, 'demo.generateSignature equals the vector (sanity of the demo itself)');
  assert(headers.sign === demoSign, 'OUR REST sign === demo REST sign (same inputs)');

  const demoWs = demoWsSign.generateSign(NONCE, String(TS_S), KEY, SECRET);
  const wsOut = signWsCore({ apiKey: KEY, secretKey: SECRET, nonce: NONCE, timestamp: TS_S });
  assert(wsOut.sign === demoWs, 'OUR WS sign === demo generateSign (nonce + SEC ts + key)');
  assert(typeof wsOut.timestamp === 'number' && wsOut.timestamp === TS_S, 'WS timestamp is a number (seconds), demo style');

  console.log('\nlive wrappers still produce valid-shape output');
  const h2 = signRest({ apiKey: KEY, secretKey: SECRET, queryParams: PARAMS, bodyString: BODY });
  assert(typeof h2.sign === 'string' && h2.sign.length === 64, 'signRest() -> 64-char hex sign');
  assert(makeNonce().length === 32, 'nonce is 32 chars');
  const w2 = signWs({ apiKey: KEY, secretKey: SECRET });
  assert(typeof w2.timestamp === 'number' && typeof w2.sign === 'string' && w2.nonce.length === 32, 'signWs() shape matches the demo login payload');

  console.log('\nquery-string building');
  assert(buildQueryString({ b: 2, a: 1 }) === '?a=1&b=2', 'buildQueryString sorts and URL-encodes');
  assert(buildQueryString({ s: 'a,b', x: undefined, y: null }) === '?s=a%2Cb', 'empty/undefined values are dropped (and stay out of the signed string)');

  // the signed string and the sent query string must use the SAME set of
  // params — that is the 10007 trap
  const P = { symbol: 'BTCUSDT', limit: 5, empty: '' };
  assert(buildQueryParamsString(P) === buildQueryParamsString({ symbol: 'BTCUSDT', limit: 5 }),
    'empty values filtered from the signed string');
  const qs = new URLSearchParams(buildQueryString(P).slice(1));
  assert(qs.get('symbol') === 'BTCUSDT' && qs.get('limit') === '5' && !qs.has('empty'),
    'empty values filtered from the URL as well');

  console.log(`\npassed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

test();
