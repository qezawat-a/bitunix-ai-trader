import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { signWs } from './sign.js';

const log = createLogger('ws');

/**
 * Bitunix WebSocket (public + private).
 * Docs: /api-docs/futures/websocket/prepare/WebSocket.html
 *  - max 5 outgoing messages per second (ping/pong counts)
 *  - max 300 channel subscriptions per connection
 *  - ping: {"op":"ping","ping":<unix seconds>}
 */
class BitunixSocket extends EventEmitter {
  constructor(url, { privateChannel = false } = {}) {
    super();
    this.url = url;
    this.privateChannel = privateChannel;
    this.ws = null;
    this.subs = new Map();      // key -> {ch, symbol}
    this.outQueue = [];
    this.alive = false;
    this.loggedIn = false;
    this.backoff = 1000;
    this._pump = setInterval(() => this._flush(), 250); // <=4 msg/s
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.alive = true;
      this.backoff = 1000;
      log.info(`connected ${this.url}`);
      if (this.privateChannel) this._login();
      else this._resubscribe();
      this._startPing();
      this.emit('open');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.op === 'ping' || msg.op === 'pong') return;
      if (msg.op === 'login') {
        this.loggedIn = msg.code === 0 || msg.data?.result === true || msg.msg === 'Success';
        log.info(`private login: ${this.loggedIn ? 'ok' : JSON.stringify(msg)}`);
        if (this.loggedIn) this._resubscribe();
        return;
      }
      if (msg.op === 'connect' || msg.op === 'subscribe' || msg.op === 'unsubscribe') return;
      if (msg.ch) this.emit('data', msg);
      this.emit('message', msg);
    });

    this.ws.on('close', () => {
      this.alive = false; this.loggedIn = false;
      clearInterval(this.pingTimer);
      log.warn(`closed ${this.url}, reconnecting in ${this.backoff}ms`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });

    this.ws.on('error', (e) => log.warn(`error: ${e.message}`));
  }

  _login() {
    const args = signWs({ apiKey: config.bitunix.key, secretKey: config.bitunix.secret });
    this.send({ op: 'login', args: [args] });
  }

  _startPing() {
    clearInterval(this.pingTimer);
    // The server drops sessions that have not pinged within ~15-25s
    // (measured 2026-10-06: no-ping/close at +26.8s, code 1006). Ping every
    // 5s — well inside the 5 msg/s out limit, and the official demo itself
    // heartbeats every 3s.
    this.pingTimer = setInterval(() => {
      this.send({ op: 'ping', ping: Math.floor(Date.now() / 1000) });
    }, 5_000);
  }

  send(obj) { this.outQueue.push(obj); }

  _flush() {
    if (!this.outQueue.length) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const obj = this.outQueue.shift();
    try { this.ws.send(JSON.stringify(obj)); } catch (e) { log.warn(e.message); }
  }

  subscribe(args) {
    const list = Array.isArray(args) ? args : [args];
    for (const a of list) this.subs.set(`${a.ch}:${a.symbol || ''}`, a);
    if (this.alive && (!this.privateChannel || this.loggedIn)) {
      for (let i = 0; i < list.length; i += 20) {
        this.send({ op: 'subscribe', args: list.slice(i, i + 20) });
      }
    }
  }

  unsubscribe(args) {
    const list = Array.isArray(args) ? args : [args];
    for (const a of list) this.subs.delete(`${a.ch}:${a.symbol || ''}`);
    this.send({ op: 'unsubscribe', args: list });
  }

  _resubscribe() {
    const all = [...this.subs.values()];
    for (let i = 0; i < all.length; i += 20) {
      this.send({ op: 'subscribe', args: all.slice(i, i + 20) });
    }
  }

  close() {
    clearInterval(this._pump);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch {}
  }
}

/**
 * Live market + account state fed by WebSocket, with REST as the source of truth.
 * Public channels (all per-symbol, verified live 2026-10-06):
 *   ticker           24h ticker {s,o,la,h,l,b,q,r}
 *   trade            fills
 *   depth_book1 / depth_books   L1 / L20 order books
 *   market_kline_<n>min         kline updates ({o,c,h,l,b,q}, no klineType split)
 * The symbol-less {ch:'tickers'} channel is NOT usable: it replies with one
 * delta batch (bd/ak/bv/av, no symbol, no price) and then goes quiet.
 * Private channels: balance, position, order, tpsl.
 */
export class MarketFeed extends EventEmitter {
  constructor() {
    super();
    this.pub = new BitunixSocket(config.bitunix.wsPublic);
    this.priv = new BitunixSocket(config.bitunix.wsPrivate, { privateChannel: true });
    this.tickers = new Map();   // symbol -> {lastPrice, markPrice, ...}
    this.positions = new Map(); // positionId -> position event
    this.balance = null;
    this.lastEventAt = 0;
  }

  start() {
    this.pub.on('data', (m) => this._onPublic(m));
    this.priv.on('data', (m) => this._onPrivate(m));
    this.pub.connect();
    this.priv.connect();
    // No global ticker stream. Verified against the live public endpoint
    // (2026-10-06): the symbol-less {ch:'tickers'} subscription answers with a
    // single delta batch ({bd,ak,bv,av}, no symbol, no price) and then
    // nothing — it cannot maintain this.tickers. Per-symbol 'ticker'
    // channels stream continuously, so call watchSymbols() once the trading
    // universe is known.
    return this;
  }

  /**
   * Subscribe a symbol's public channels: its 24h ticker plus one kline
   * series. The public WS is per-symbol only. Kline channel names use the
   * "min" suffix for minute timeframes (market_kline_1min, verified live;
   * the short form market_kline_1m returns an empty ack and nothing else),
   * so minute TFs are translated and anything else is sent verbatim.
   */
  watchSymbols(symbols, interval = '1m') {
    const list = [];
    for (const s of symbols) {
      list.push({ symbol: s, ch: 'ticker' });
      const ch = String(interval).replace(/^(\d+)m$/, '$1min');
      list.push({ symbol: s, ch: `market_kline_${ch}` });
    }
    this.pub.subscribe(list);
    return this;
  }

  subscribePrivate() {
    this.priv.subscribe([{ ch: 'balance' }, { ch: 'position' }, { ch: 'order' }, { ch: 'tpsl' }]);
  }

  _onPublic(m) {
    this.lastEventAt = Date.now();
    if (m.ch === 'tickers' || m.ch === 'ticker') {
      const arr = Array.isArray(m.data) ? m.data : [m.data];
      for (const t of arr) {
        if (!t?.s && !t?.symbol) continue;
        const symbol = t.symbol || t.s;
        const prev = this.tickers.get(symbol) || {};
        this.tickers.set(symbol, {
          ...prev,
          symbol,
          lastPrice: Number(t.la ?? t.lastPrice ?? prev.lastPrice ?? 0),
          markPrice: Number(t.mp ?? t.markPrice ?? prev.markPrice ?? 0),
          high: Number(t.h ?? t.high ?? prev.high ?? 0),
          low: Number(t.l ?? t.low ?? prev.low ?? 0),
          baseVol: Number(t.b ?? t.baseVol ?? prev.baseVol ?? 0),
          quoteVol: Number(t.q ?? t.quoteVol ?? prev.quoteVol ?? 0),
          ts: m.ts || Date.now(),
        });
      }
      this.emit('tickers', this.tickers);
      return;
    }
    if (String(m.ch).startsWith('market_kline_')) this.emit('kline', m);
    if (m.ch === 'depth_books' || String(m.ch).startsWith('depth')) this.emit('depth', m);
  }

  _onPrivate(m) {
    this.lastEventAt = Date.now();
    if (m.ch === 'balance') { this.balance = m.data; this.emit('balance', m.data); }
    else if (m.ch === 'position') { this.emit('position', m.data); }
    else if (m.ch === 'order') { this.emit('order', m.data); }
    else if (m.ch === 'tpsl') { this.emit('tpsl', m.data); }
  }

  price(symbol) {
    const t = this.tickers.get(symbol);
    return t ? (t.markPrice || t.lastPrice) : null;
  }

  stop() { this.pub.close(); this.priv.close(); }
}

export const feed = new MarketFeed();
export default feed;
