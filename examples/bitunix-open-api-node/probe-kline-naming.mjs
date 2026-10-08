import WebSocket from 'ws';
const URL = 'wss://fapi.bitunix.com/public/';
const SEEN = new Map();
const SUBS = [
  { ch: 'market_kline_3min', symbol: 'BTCUSDT' },
  { ch: 'market_kline_15min', symbol: 'BTCUSDT' },
  { ch: 'market_kline_1hour', symbol: 'BTCUSDT' },
  { ch: 'market_kline_1hr', symbol: 'BTCUSDT' },
];
const ws = new WebSocket(URL);
ws.on('open', () => ws.send(JSON.stringify({ op: 'subscribe', args: SUBS })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.op) return;
  const e = SEEN.get(m.ch) || { count: 0, empties: 0 };
  e.count += 1;
  if (!m.data || !Object.keys(m.data).length) e.empties += 1;
  SEEN.set(m.ch, e);
});
setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) })); }, 10000);
setTimeout(() => {
  console.log('--- summary (20s) ---');
  for (const s of SUBS) {
    const e = SEEN.get(s.ch);
    console.log(`  ${s.ch.padEnd(22)} ${e ? `${e.count} msg, ${e.empties} empty` : 'NO MESSAGES'}`);
  }
  process.exit(0);
}, 20000);
