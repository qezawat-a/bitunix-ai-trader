/**
 * Read-only probe of Bitunix public WS channels.
 * Verifies which channel names in src/exchange/ws.js actually deliver data:
 *   - global 'tickers' (no symbol)  vs per-symbol 'ticker'
 *   - 'market_kline_*' kline channels
 *   - 'depth_book1' vs 'depth_books'
 * Public endpoint, no credentials, market data only. Exits after ~25s.
 */
import WebSocket from 'ws';

const URL = 'wss://fapi.bitunix.com/public/';
const SEEN = new Map(); // ch -> {count, sample}
const SUBS = [
  { ch: 'tickers' },
  { ch: 'ticker', symbol: 'BTCUSDT' },
  { ch: 'trade', symbol: 'BTCUSDT' },
  { ch: 'depth_book1', symbol: 'BTCUSDT' },
  { ch: 'depth_books', symbol: 'BTCUSDT' },
  { ch: 'market_kline_1min', symbol: 'BTCUSDT' },
  { ch: 'market_kline_5min', symbol: 'BTCUSDT' },
];

const ws = new WebSocket(URL);
ws.on('open', () => {
  ws.send(JSON.stringify({ op: 'subscribe', args: SUBS }));
  console.log('subscribed:', SUBS.map((s) => s.ch + (s.symbol ? ':' + s.symbol : '')).join(', '));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.op) {
    if (m.op === 'pong' || m.op === 'connect') {
      console.log(`[${m.op}]`, JSON.stringify(m.data ?? m));
      return;
    }
    if (m.op === 'subscribe') {
      console.log('[subscribe-response]', JSON.stringify(m));
      return;
    }
    return;
  }
  const key = m.ch;
  const e = SEEN.get(key) || { count: 0, sample: null, symbol: m.symbol ?? null };
  e.count += 1;
  if (!e.sample) e.sample = m;
  SEEN.set(key, e);
  if (e.count === 1) {
    const dataStr = JSON.stringify(m.data).slice(0, 220);
    console.log(`first '${key}' sample: ${dataStr}`);
  }
});
ws.on('error', (e) => console.log('ws error:', e.message));
ws.on('close', (code, reason) => console.log('closed:', code, String(reason)));

const ping = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) }));
  }
}, 10_000);

setTimeout(() => {
  clearInterval(ping);
  console.log('\n--- summary ---');
  for (const [ch, e] of SEEN) console.log(`  ${ch.padEnd(20)} ${e.count} msg(s)${e.symbol ? ` [${e.symbol}]` : ''}`);
  const wanted = SUBS.map((s) => s.ch);
  for (const w of wanted) {
    if (!SEEN.has(w)) console.log(`  ${w.padEnd(20)} NO DATA delivered`);
  }
  ws.close();
  process.exit(0);
}, 25_000);
