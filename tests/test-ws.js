/** WebSocket wiring: both sockets connect, subscribe once, and resubscribe. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { BitunixSocket, MarketFeed } from '../src/exchange/ws.js';

let passed = 0;
const check = (cond, msg) => { assert.ok(cond, msg); passed++; };

console.log('=== WebSocket public + private ===\n');

console.log('subscriptions are queued before connect and deduped');
{
  const s = new BitunixSocket('wss://example.invalid/public');
  s.subscribe([{ ch: 'ticker', symbol: 'BTCUSDT' }, { ch: 'market_kline_1min', symbol: 'BTCUSDT' }]);
  check(s.subs.size === 2, 'channels are remembered while offline');
  check(s.outQueue.length === 0, 'nothing is sent before the socket is open');

  const sent = [];
  s.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  s.alive = true;
  s.subscribe([{ ch: 'ticker', symbol: 'BTCUSDT' }]);
  check(s.outQueue.length === 0 && sent.length === 0, 're-subscribing to a known channel sends nothing');

  s.subscribe({ ch: 'ticker', symbol: 'ETHUSDT' });
  check(s.outQueue.length === 1, 'a genuinely new channel is queued');
  s._flush();
  check(sent.length === 1 && sent[0].op === 'subscribe', 'it is sent as a subscribe op');
  check(sent[0].args[0].symbol === 'ETHUSDT', 'with the new symbol only');

  s._resubscribe();
  check(s.outQueue.length === 1, 'reconnect resubscribes the full set in one batch');
  s._flush();
  check(sent[1].args.length === 3, 'all three channels are restored');
}

console.log('\nprivate channels wait for login');
{
  const p = new BitunixSocket('wss://example.invalid/private', { privateChannel: true });
  p.subscribe([{ ch: 'balance' }, { ch: 'position' }]);
  p.alive = true;
  p.subscribe({ ch: 'order' });
  check(p.subs.size === 3, 'channels are remembered');
  check(p.outQueue.length === 0, 'not sent before login');

  p.loggedIn = true;
  p.subscribe({ ch: 'tpsl' });
  check(p.outQueue.length === 1, 'after login the new channel is queued');
  p.outQueue = [];
  p._resubscribe();
  check(p.outQueue.length === 1 && p.outQueue[0].args.length === 4,
    'login/resubscribe sends balance, position, order, tpsl');
}

console.log('\nMarketFeed watches the scanned universe');
{
  const f = new MarketFeed();
  f.watchSymbols(['BTCUSDT', 'ETHUSDT'], '1m');
  check(f.pub.subs.size === 4, 'two symbols -> two channels each');
  check([...f.pub.subs.keys()].includes('ticker:BTCUSDT'), 'ticker channel per symbol');
  check([...f.pub.subs.keys()].includes('market_kline_1min:BTCUSDT'),
    'minute kline channel uses the API\'s "min" spelling');
  f.watchSymbols(['BTCUSDT', 'ETHUSDT'], '1m');
  check(f.pub.subs.size === 4, 'the next scan does not duplicate subscriptions');
  f.subscribePrivate();
  check(f.priv.subs.size === 4, 'private set is balance, position, order, tpsl');
  const st = f.status();
  check(st.public.subscriptions === 4 && st.private.subscriptions === 4, 'status reports both subscription sets');
}

console.log('\nstart() connects BOTH sockets and queues private channels');
{
  const mk = () => {
    const s = new EventEmitter();
    s.connectCalls = 0;
    s.subs = new Map();
    s.connect = () => { s.connectCalls++; s.alive = true; };
    s.subscribe = (a) => { for (const x of (Array.isArray(a) ? a : [a])) s.subs.set(`${x.ch}:${x.symbol || ''}`, x); };
    return s;
  };
  const f = new MarketFeed();
  f.pub = mk();
  f.priv = mk();
  f.start();
  check(f.pub.connectCalls === 1 && f.priv.connectCalls === 1, 'public and private both connect');
  check(f.priv.subs.size === 4, 'private channels are subscribed without the caller doing it');
  f.start();
  check(f.pub.connectCalls === 1 && f.priv.connectCalls === 1, 'start() is idempotent');
}

console.log('\nreal sockets: public subscribes, private logs in then subscribes');
{
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const seen = [];
  wss.on('connection', (ws, req) => {
    const role = req.url.includes('private') ? 'private' : 'public';
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      seen.push({ role, op: m.op, args: m.args?.length || 0 });
      if (role === 'private' && m.op === 'login') {
        ws.send(JSON.stringify({ op: 'login', code: 0, msg: 'Success' }));
      }
    });
  });

  const waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - started > ms) return reject(new Error('timed out waiting for websocket message'));
      setTimeout(tick, 25);
    };
    tick();
  });

  const pub = new BitunixSocket(`ws://127.0.0.1:${port}/public`);
  pub.subscribe([{ ch: 'ticker', symbol: 'BTCUSDT' }, { ch: 'market_kline_1min', symbol: 'BTCUSDT' }]);
  pub.connect();
  await waitFor(() => seen.some((x) => x.role === 'public' && x.op === 'subscribe' && x.args === 2));
  check(pub.alive === true, 'public socket is open');
  check(seen.some((x) => x.role === 'public' && x.op === 'subscribe' && x.args === 2),
    'public socket sends both ticker and kline subscriptions');

  const priv = new BitunixSocket(`ws://127.0.0.1:${port}/private`, { privateChannel: true });
  priv.subscribe([{ ch: 'balance' }, { ch: 'position' }, { ch: 'order' }, { ch: 'tpsl' }]);
  priv.connect();
  await waitFor(() => seen.some((x) => x.role === 'private' && x.op === 'subscribe' && x.args === 4));
  check(priv.loggedIn === true, 'private socket completes the login handshake');
  check(seen.some((x) => x.role === 'private' && x.op === 'subscribe' && x.args === 4),
    'private socket subscribes after login');

  pub.close();
  priv.close();
  await new Promise((r) => wss.close(r));
}

console.log(`\npassed ${passed}`);
process.exit(0);
