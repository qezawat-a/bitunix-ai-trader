import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { signRest, buildQueryString } from './sign.js';
import { BitunixError } from './errors.js';

const log = createLogger('bitunix');

/**
 * Bitunix USDT-M Futures REST client.
 * Every endpoint below is a 1:1 mapping of the official documentation —
 * paths, parameter names and enum values are taken verbatim from the docs.
 */
export class BitunixClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || config.bitunix.baseUrl;
    this.apiKey = opts.apiKey || config.bitunix.key;
    this.apiSecret = opts.apiSecret || config.bitunix.secret;
    this.marginCoin = opts.marginCoin || config.bitunix.marginCoin;
    this._pairCache = { at: 0, map: new Map() };
    this._rateWindow = [];
  }

  // ---------------------------------------------------------------- internals

  async _throttle() {
    // global soft limiter: 8 req / sec (docs allow 10/sec, keep headroom)
    const now = Date.now();
    this._rateWindow = this._rateWindow.filter((t) => now - t < 1000);
    if (this._rateWindow.length >= 8) {
      await new Promise((r) => setTimeout(r, 1000 - (now - this._rateWindow[0]) + 5));
      return this._throttle();
    }
    this._rateWindow.push(Date.now());
  }

  async _request(method, path, { query = {}, body = null, auth = true, retries = 2 } = {}) {
    await this._throttle();

    const bodyString = body ? JSON.stringify(body) : '';
    const qs = buildQueryString(query);
    const url = `${this.baseUrl}${path}${qs}`;

    const headers = auth
      ? signRest({
          apiKey: this.apiKey,
          secretKey: this.apiSecret,
          queryParams: query,
          bodyString,
        })
      : { 'Content-Type': 'application/json', language: 'en-US' };

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyString || undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 400));
        return this._request(method, path, { query, body, auth, retries: retries - 1 });
      }
      throw new BitunixError(10001, `network: ${e.message}`, { path });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BitunixError(40001, `non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, { path });
    }

    const code = Number(json.code);
    if (code !== 0) {
      const err = new BitunixError(code, json.msg, { path, query, body });
      if (err.retryable && retries > 0) {
        await new Promise((r) => setTimeout(r, 600));
        return this._request(method, path, { query, body, auth, retries: retries - 1 });
      }
      throw err;
    }
    return json.data;
  }

  _get(path, query, auth = true) { return this._request('GET', path, { query, auth }); }
  _post(path, body, auth = true) { return this._request('POST', path, { body, auth }); }

  // ------------------------------------------------------------------ market
  // GET /api/v1/futures/market/tickers
  getTickers(symbols) {
    return this._get('/api/v1/futures/market/tickers',
      symbols ? { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols } : {}, false);
  }

  // GET /api/v1/futures/market/depth   limit: 1/5/15/50/max
  getDepth(symbol, limit = 15) {
    return this._get('/api/v1/futures/market/depth', { symbol, limit }, false);
  }

  // GET /api/v1/futures/market/kline   interval: 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M
  // NOTE: the public docs omit 3m, but the endpoint serves it — verified live
  // (bars exactly 180s apart, a distinct series from 5m). An unsupported
  // interval returns code 0 with an EMPTY data array, never an error.
  // The official SDK's KlineRequest names this field klineType (LAST_PRICE |
  // MARK_PRICE), not type. Probing shows the endpoint currently ignores both
  // spellings — the same series comes back either way — but send the name the
  // SDK uses so this keeps working if they wire it up.
  getKline({ symbol, interval, limit = 200, startTime, endTime, klineType }) {
    return this._get('/api/v1/futures/market/kline',
      { symbol, interval, limit, startTime, endTime, klineType }, false);
  }

  // GET /api/v1/futures/market/trading_pairs
  getTradingPairs(symbols) {
    return this._get('/api/v1/futures/market/trading_pairs',
      symbols ? { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols } : {}, false);
  }

  // GET /api/v1/futures/market/funding_rate
  // Returns a single OBJECT (not an array) — unlike the /batch variant.
  // Normalised here so callers never have to guess the shape.
  async getFundingRate(symbol) {
    const r = await this._get('/api/v1/futures/market/funding_rate', { symbol }, false);
    const row = Array.isArray(r) ? r[0] : r;
    if (!row) throw new BitunixError(-1, `no funding rate returned for ${symbol}`);
    return row;
  }

  // GET /api/v1/futures/market/funding_rate/batch
  getFundingRateBatch(symbols) {
    return this._get('/api/v1/futures/market/funding_rate/batch',
      symbols ? { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols } : {}, false);
  }

  // GET /api/v1/futures/market/get_funding_rate_history
  // NOTE: the docs spell the start parameter "starTime" (sic) — sent verbatim.
  getFundingRateHistory({ symbol, startTime, endTime, limit = 100 }) {
    return this._get('/api/v1/futures/market/get_funding_rate_history',
      { symbol, starTime: startTime, endTime, limit }, false);
  }

  // ----------------------------------------------------------------- account
  // GET /api/v1/futures/account
  getAccount(marginCoin = this.marginCoin) {
    return this._get('/api/v1/futures/account', { marginCoin });
  }

  // GET /api/v1/futures/account/get_leverage_margin_mode
  getLeverageAndMarginMode(symbol, marginCoin = this.marginCoin) {
    return this._get('/api/v1/futures/account/get_leverage_margin_mode', { symbol, marginCoin });
  }

  // POST /api/v1/futures/account/change_leverage
  changeLeverage({ symbol, leverage, marginCoin = this.marginCoin }) {
    return this._post('/api/v1/futures/account/change_leverage',
      { symbol, leverage: Number(leverage), marginCoin });
  }

  // POST /api/v1/futures/account/change_margin_mode  marginMode: ISOLATION | CROSS
  changeMarginMode({ symbol, marginMode, marginCoin = this.marginCoin }) {
    return this._post('/api/v1/futures/account/change_margin_mode',
      { marginMode, symbol, marginCoin });
  }

  // POST /api/v1/futures/account/change_position_mode  positionMode: ONE_WAY | HEDGE
  changePositionMode(positionMode) {
    return this._post('/api/v1/futures/account/change_position_mode', { positionMode });
  }

  // POST /api/v1/futures/account/adjust_position_margin  (isolated margin only)
  // amount: positive adds margin, negative reduces it. Either side or positionId.
  adjustPositionMargin({ symbol, marginCoin = this.marginCoin, amount, side, positionId }) {
    const body = { symbol, marginCoin, amount: String(amount) };
    if (positionId) body.positionId = String(positionId);
    else if (side) body.side = side;
    return this._post('/api/v1/futures/account/adjust_position_margin', body);
  }

  // GET /api/v1/cp/asset/query  (copy-trading asset query, takes no parameters)
  getCopyTradingAsset() {
    return this._get('/api/v1/cp/asset/query', {});
  }

  // ---------------------------------------------------------------- position
  // GET /api/v1/futures/position/get_pending_positions
  getPendingPositions({ symbol, positionId } = {}) {
    return this._get('/api/v1/futures/position/get_pending_positions', { symbol, positionId });
  }

  // GET /api/v1/futures/position/get_history_positions
  getHistoryPositions({ symbol, positionId, startTime, endTime, skip = 0, limit = 10 } = {}) {
    return this._get('/api/v1/futures/position/get_history_positions',
      { symbol, positionId, startTime, endTime, skip, limit });
  }

  // GET /api/v1/futures/position/get_position_tiers
  // The official SDK (GetPositionTiersRequest) sends ONLY symbol.
  getPositionTiers({ symbol }) {
    return this._get('/api/v1/futures/position/get_position_tiers', { symbol });
  }

  /**
   * Risk tiers for a symbol, cached.
   *
   * Each tier is {level, startValue, endValue, leverage, maintenanceMarginRate}
   * keyed on POSITION VALUE in USDT, and both the maintenance margin rate and
   * the maximum leverage change as the position grows. Live BTCUSDT:
   *
   *   L1        0 -   100k   200x   MMR 0.30%
   *   L2     100k -   400k   150x   MMR 0.40%
   *   L3     400k -     1M   100x   MMR 0.50%
   *   ...
   *
   * This is the authoritative source for MMR. Before this endpoint was wired
   * in, MMR was guessed from maxLeverage, which over-stated it on every pair
   * (BTC 0.50% guessed vs 0.30% real) and needlessly capped leverage.
   */
  async positionTiers(symbol) {
    if (!this._tierCache) this._tierCache = new Map();
    const hit = this._tierCache.get(symbol);
    if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.tiers;
    const raw = await this.getPositionTiers({ symbol });
    const tiers = (Array.isArray(raw) ? raw : [])
      .map((t) => ({
        level: Number(t.level),
        startValue: Number(t.startValue),
        endValue: Number(t.endValue),
        leverage: Number(t.leverage),
        mmr: Number(t.maintenanceMarginRate),
      }))
      .filter((t) => Number.isFinite(t.mmr) && t.mmr > 0)
      .sort((a, b) => a.startValue - b.startValue);
    if (!tiers.length) throw new Error(`no position tiers returned for ${symbol}`);
    this._tierCache.set(symbol, { at: Date.now(), tiers });
    return tiers;
  }

  /**
   * The tier a position of this notional value falls into.
   * Returns the top tier if the notional exceeds every band.
   */
  async tierFor({ symbol, notional }) {
    const tiers = await this.positionTiers(symbol);
    const v = Number(notional) || 0;
    return tiers.find((t) => v > t.startValue && v <= t.endValue)
      || tiers.find((t) => v <= t.endValue)
      || tiers[tiers.length - 1];
  }

  // ------------------------------------------------------------------- trade
  /**
   * POST /api/v1/futures/trade/place_order
   * HEDGE mode: side BUY + tradeSide OPEN  = open long
   *             side SELL + tradeSide OPEN = open short
   *             side SELL + tradeSide CLOSE + positionId = close long
   *             side BUY  + tradeSide CLOSE + positionId = close short
   */
  placeOrder(params) {
    const body = {
      symbol: params.symbol,
      marginCoin: params.marginCoin || this.marginCoin,
      qty: String(params.qty),
      side: params.side,
      orderType: params.orderType || 'MARKET',
    };
    if (params.price !== undefined) body.price = String(params.price);
    if (params.tradeSide) body.tradeSide = params.tradeSide;
    if (params.positionId) body.positionId = String(params.positionId);
    if (params.effect) body.effect = params.effect;
    if (params.clientId) body.clientId = String(params.clientId);
    if (params.reduceOnly !== undefined) body.reduceOnly = Boolean(params.reduceOnly);
    if (params.tpPrice !== undefined) {
      body.tpPrice = String(params.tpPrice);
      body.tpStopType = params.tpStopType || 'MARK_PRICE';
      body.tpOrderType = params.tpOrderType || 'MARKET';
      if (body.tpOrderType === 'LIMIT') body.tpOrderPrice = String(params.tpOrderPrice ?? params.tpPrice);
    }
    if (params.slPrice !== undefined) {
      body.slPrice = String(params.slPrice);
      body.slStopType = params.slStopType || 'MARK_PRICE';
      body.slOrderType = params.slOrderType || 'MARKET';
      if (body.slOrderType === 'LIMIT') body.slOrderPrice = String(params.slOrderPrice ?? params.slPrice);
    }
    return this._post('/api/v1/futures/trade/place_order', body);
  }

  // POST /api/v1/futures/trade/batch_order
  batchOrder({ symbol, orderList }) {
    return this._post('/api/v1/futures/trade/batch_order', { symbol, orderList });
  }

  // POST /api/v1/futures/trade/modify_order
  modifyOrder(params) {
    return this._post('/api/v1/futures/trade/modify_order', params);
  }

  // POST /api/v1/futures/trade/cancel_orders
  cancelOrders({ symbol, orderList, marginCoin = this.marginCoin }) {
    return this._post('/api/v1/futures/trade/cancel_orders', { symbol, orderList, marginCoin });
  }

  // POST /api/v1/futures/trade/cancel_all_orders
  cancelAllOrders({ symbol, marginCoin = this.marginCoin } = {}) {
    return this._post('/api/v1/futures/trade/cancel_all_orders',
      symbol ? { symbol, marginCoin } : { marginCoin });
  }

  // POST /api/v1/futures/trade/close_all_position
  closeAllPositions({ symbol } = {}) {
    return this._post('/api/v1/futures/trade/close_all_position', symbol ? { symbol } : {});
  }

  // POST /api/v1/futures/trade/flash_close_position
  flashClosePosition(positionId, marginCoin = this.marginCoin) {
    return this._post('/api/v1/futures/trade/flash_close_position',
      { positionId: String(positionId), marginCoin });
  }

  // GET /api/v1/futures/trade/get_pending_orders
  getPendingOrders({ symbol, orderId, clientId, status, startTime, endTime, skip = 0, limit = 50,
    marginCoin = this.marginCoin } = {}) {
    return this._get('/api/v1/futures/trade/get_pending_orders',
      { symbol, orderId, clientId, status, startTime, endTime, skip, limit, marginCoin });
  }

  // GET /api/v1/futures/trade/get_history_orders
  getHistoryOrders({ symbol, orderId, clientId, status, type, startTime, endTime, skip = 0, limit = 20,
    marginCoin = this.marginCoin } = {}) {
    return this._get('/api/v1/futures/trade/get_history_orders',
      { symbol, orderId, clientId, status, type, startTime, endTime, skip, limit, marginCoin });
  }

  // GET /api/v1/futures/trade/get_history_trades
  getHistoryTrades({ symbol, orderId, positionId, startTime, endTime, skip = 0, limit = 20,
    marginCoin = this.marginCoin } = {}) {
    return this._get('/api/v1/futures/trade/get_history_trades',
      { symbol, orderId, positionId, startTime, endTime, skip, limit, marginCoin });
  }

  // GET /api/v1/futures/trade/get_order_detail
  getOrderDetail({ orderId, clientId }) {
    return this._get('/api/v1/futures/trade/get_order_detail', { orderId, clientId });
  }

  // ------------------------------------------------------------------- tp/sl
  // POST /api/v1/futures/tpsl/position/place_order  (one per position, closes whole position at market)
  placePositionTpSl({ symbol, positionId, tpPrice, tpStopType, slPrice, slStopType }) {
    const body = { symbol, positionId: String(positionId) };
    if (tpPrice !== undefined && tpPrice !== null) {
      body.tpPrice = String(tpPrice);
      body.tpStopType = tpStopType || 'MARK_PRICE';
    }
    if (slPrice !== undefined && slPrice !== null) {
      body.slPrice = String(slPrice);
      body.slStopType = slStopType || 'MARK_PRICE';
    }
    return this._post('/api/v1/futures/tpsl/position/place_order', body);
  }

  // POST /api/v1/futures/tpsl/position/modify_order
  modifyPositionTpSl({ symbol, positionId, tpPrice, tpStopType, slPrice, slStopType }) {
    const body = { symbol, positionId: String(positionId) };
    if (tpPrice !== undefined && tpPrice !== null) {
      body.tpPrice = String(tpPrice);
      body.tpStopType = tpStopType || 'MARK_PRICE';
    }
    if (slPrice !== undefined && slPrice !== null) {
      body.slPrice = String(slPrice);
      body.slStopType = slStopType || 'MARK_PRICE';
    }
    return this._post('/api/v1/futures/tpsl/position/modify_order', body);
  }

  // POST /api/v1/futures/tpsl/place_order   (partial tp/sl with qty)
  placeTpSlOrder(params) {
    return this._post('/api/v1/futures/tpsl/place_order', params);
  }

  // POST /api/v1/futures/tpsl/modify_order
  modifyTpSlOrder(params) {
    return this._post('/api/v1/futures/tpsl/modify_order', params);
  }

  // POST /api/v1/futures/tpsl/cancel_order
  cancelTpSlOrder({ symbol, orderId }) {
    return this._post('/api/v1/futures/tpsl/cancel_order', { symbol, orderId: String(orderId) });
  }

  // GET /api/v1/futures/tpsl/get_pending_orders
  getPendingTpSlOrders({ symbol, positionId, side, positionMode, skip = 0, limit = 50 } = {}) {
    return this._get('/api/v1/futures/tpsl/get_pending_orders',
      { symbol, positionId, side, positionMode, skip, limit });
  }

  // GET /api/v1/futures/tpsl/get_history_orders
  getHistoryTpSlOrders({ symbol, side, positionMode, startTime, endTime, skip = 0, limit = 20 } = {}) {
    return this._get('/api/v1/futures/tpsl/get_history_orders',
      { symbol, side, positionMode, startTime, endTime, skip, limit });
  }

  // ---------------------------------------------------------------- helpers

  /** Trading-pair metadata cache (precision, min qty, leverage limits). */
  async pairInfo(symbol) {
    if (Date.now() - this._pairCache.at > 10 * 60_000 || !this._pairCache.map.size) {
      const list = await this.getTradingPairs();
      const map = new Map();
      for (const p of list || []) map.set(p.symbol, p);
      this._pairCache = { at: Date.now(), map };
    }
    return this._pairCache.map.get(symbol) || null;
  }

  async allPairs() {
    await this.pairInfo('BTCUSDT');
    return [...this._pairCache.map.values()];
  }

  /** Round a base-coin quantity to the pair's basePrecision, respecting minTradeVolume. */
  async roundQty(symbol, qty) {
    const info = await this.pairInfo(symbol);
    const prec = Number(info?.basePrecision ?? 4);
    const min = Number(info?.minTradeVolume ?? 0);
    const f = Math.pow(10, prec);
    let q = Math.floor(Number(qty) * f) / f;
    if (min && q < min) q = min;
    return q.toFixed(prec);
  }

  /** Round a price to the pair's quotePrecision. */
  async roundPrice(symbol, price) {
    const info = await this.pairInfo(symbol);
    const prec = Number(info?.quotePrecision ?? 2);
    return Number(price).toFixed(prec);
  }

  /**
   * The three order units, straight from the Bitunix help centre article
   * "Explanation of the Order Units in Futures Trading" (id=170):
   *
   *   "Bitunix offers Nominal Value, Cost Value, and Quantity Unit as the
   *    units for placing orders"
   *
   * They are three DIFFERENT numbers describing the same position, and the
   * amount you type means something different under each:
   *
   *   NOMINAL  the market value of the position, in USDT. Leverage does not
   *            multiply it — it IS the exposure.
   *              qty = nominal / price
   *              cost = nominal / leverage
   *            Doc example: 1000 USDT nominal, 10x, price 10000
   *              -> cost 1000/10 = 100, qty 1000/10000 = 0.1
   *
   *   COST     the money you actually commit: initial margin plus fees.
   *            Leverage does not change what you pay, it changes what that
   *            payment controls.
   *              qty = cost * leverage / price
   *              nominal = cost * leverage
   *            Doc example: 1000 USDT cost, 10x, price 10000
   *              -> qty 1000*10/10000 = 1, nominal 10000
   *
   *   QTY      base coin, the exchange's own unit.
   *              cost = qty * price / leverage
   *              nominal = qty * price
   *            Doc example: qty 1, 10x, price 10000
   *              -> cost 1*10000/10 = 1000, nominal 10000
   *
   * Note the API itself has no unit field: POST trade/place_order documents
   * qty as "Amount (base coin)" and nothing else. The unit is purely how the
   * caller thinks; every path has to end in base coin, which is what this
   * returns.
   */
  async sizeOrder({ symbol, unit, amount, leverage, price }) {
    const a = Number(amount);
    const lev = Number(leverage);
    const px = Number(price);
    if (!(a > 0) || !(lev > 0) || !(px > 0)) {
      throw new Error(`sizeOrder: bad inputs (amount ${amount}, leverage ${leverage}, price ${price})`);
    }
    const u = String(unit || 'COST').toUpperCase();
    let qty;
    let cost;
    let nominal;
    switch (u) {
      case 'NOMINAL':
        nominal = a;
        cost = a / lev;
        qty = a / px;
        break;
      case 'COST':
        cost = a;
        nominal = a * lev;
        qty = (a * lev) / px;
        break;
      case 'QTY':
        qty = a;
        nominal = a * px;
        cost = (a * px) / lev;
        break;
      default:
        throw new Error(`unknown order unit "${unit}". Valid: NOMINAL, COST, QTY`);
    }
    const rounded = await this.roundQty(symbol, qty);
    // report the cost/nominal that the ROUNDED qty actually implies, not the
    // requested ones — rounding to basePrecision can move them materially on
    // a high-priced pair
    const effNominal = Number(rounded) * px;
    return {
      qty: rounded,
      cost: effNominal / lev,
      nominal: effNominal,
      requestedCost: cost,
      requestedNominal: nominal,
      unit: u,
    };
  }

  /**
   * ORDER_UNIT = COST : the caller thinks in USDT margin.
   *   qty = cost * leverage / price   (help centre id=170)
   * Kept as a thin wrapper over sizeOrder for callers that only want qty.
   */
  async qtyFromCost({ symbol, costUsdt, leverage, price }) {
    const r = await this.sizeOrder({ symbol, unit: 'COST', amount: costUsdt, leverage, price });
    return r.qty;
  }
}

export const bitunix = new BitunixClient();
export default bitunix;
