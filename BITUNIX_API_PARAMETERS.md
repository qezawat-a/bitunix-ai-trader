# Bitunix API Parameter Reference

Complete parameter-level reference for all Bitunix Futures API endpoints implemented in this project.
Parameter names, types, and enum values are taken verbatim from the official documentation:
https://www.bitunix.com/api-docs/futures/

Base URL: `https://fapi.bitunix.com` (futures)
Spot Base URL: `https://openapi.bitunix.com`

---

## Signing (All Private Endpoints)

Bitunix uses double SHA-256 signing:

```
digest = SHA256(nonce + timestamp + apiKey + sortedQueryParams + body)
sign   = SHA256(digest + secretKey)
```

- **nonce**: random 32-char hex string (16 bytes)
- **timestamp**: milliseconds (REST) or seconds (WebSocket), as string
- **queryParams**: keys sorted ASCII, concatenated as `key+value` with no separators
- **body**: raw compact JSON string, empty string when no body
- **Headers sent**: `api-key`, `nonce`, `timestamp`, `sign`, `language: en-US`, `Content-Type: application/json`

Implementation: `src/exchange/sign.js` (REST) and `bitunix-mcp/src/sign.ts` (MCP).


## Market Data (Public — No Auth)

### GET /api/v1/futures/market/tickers
Get 24h ticker data.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbols | string | optional | Comma-separated symbol list, max 50, e.g. "BTCUSDT,ETHUSDT" |

Implementation: `getTickers(symbols)` in `src/exchange/bitunix.js`

---

### GET /api/v1/futures/market/depth
Get order book depth.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair, e.g. "BTCUSDT" |
| limit | number | optional | Depth levels: 1, 5, 15, 50, or max. Default 15. Max 200. |

Implementation: `getDepth(symbol, limit = 15)`

---

### GET /api/v1/futures/market/kline
Get candlestick data.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair, e.g. "BTCUSDT" |
| interval | string | yes | Candle interval: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M |
| limit | number | optional | Number of candles, max 200, default 200 |
| startTime | number | optional | Start time, unix milliseconds |
| endTime | number | optional | End time, unix milliseconds |
| type | string | optional | Price type: "LAST_PRICE" or "MARK_PRICE". Default LAST_PRICE. **Must be `type`, not `klineType`.** |

Implementation: `getKline({ symbol, interval, limit, startTime, endTime, type })`

Notes:
- The endpoint serves 3m even though it's omitted from some enums; verified live.
- An unsupported interval returns code 0 with empty data array, never an error.
- Sending `klineType` instead of `type` silently falls back to LAST_PRICE default.

---

### GET /api/v1/futures/market/trading_pairs
List futures trading pairs and contract specs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbols | string | optional | Comma-separated symbol list, max 50 |

Implementation: `getTradingPairs(symbols)`

Response includes: symbol, basePrecision, quotePrecision, minTradeVolume, leverage limits, etc.

---

### GET /api/v1/futures/market/funding_rate
Get current funding rate for a symbol. Returns a single object (not array).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair, e.g. "BTCUSDT" |

Implementation: `getFundingRate(symbol)` — normalises array/object response.

---

### GET /api/v1/futures/market/funding_rate/batch
Get funding rates for multiple symbols.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbols | string | optional | Comma-separated symbol list |

Implementation: `getFundingRateBatch(symbols)`

---

### GET /api/v1/futures/market/get_funding_rate_history
Get funding rate history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| startTime | number | optional | Start settlement window, unix ms |
| endTime | number | optional | End settlement window, unix ms |
| limit | number | optional | Max 200, default 100 |

Implementation: `getFundingRateHistory({ symbol, startTime, endTime, limit = 100 })`

## Account (Private — Auth Required)

### GET /api/v1/futures/account
Get futures account balance and margin info.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| marginCoin | string | optional | Margin coin, default "USDT" |

Implementation: `getAccount(marginCoin = this.marginCoin)`

---

### GET /api/v1/futures/account/get_leverage_margin_mode
Get leverage and margin mode for a symbol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| marginCoin | string | optional | Default "USDT" |

Implementation: `getLeverageAndMarginMode(symbol, marginCoin)`

---

### POST /api/v1/futures/account/change_leverage
Change leverage for a symbol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| leverage | number | yes | Leverage value (1-125) |
| marginCoin | string | optional | Default "USDT" |

Implementation: `changeLeverage({ symbol, leverage, marginCoin })`

---

### POST /api/v1/futures/account/change_margin_mode
Change margin mode: ISOLATION or CROSS.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| marginMode | string | yes | "ISOLATION" or "CROSS" |
| marginCoin | string | optional | Default "USDT" |

Implementation: `changeMarginMode({ symbol, marginMode, marginCoin })`

---

### POST /api/v1/futures/account/change_position_mode
Change position mode: ONE_WAY or HEDGE.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| positionMode | string | yes | "ONE_WAY" or "HEDGE" |

Implementation: `changePositionMode(positionMode)`

---

### POST /api/v1/futures/account/adjust_position_margin
Adjust isolated margin amount (isolated margin only).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| marginCoin | string | optional | Default "USDT" |
| amount | string | yes | Positive adds margin, negative reduces |
| side | string | optional | Position side (required if no positionId) |
| positionId | string | optional | Position ID (required if no side) |

Implementation: `adjustPositionMargin({ symbol, marginCoin, amount, side, positionId })`

---

### GET /api/v1/cp/asset/query
Copy-trading asset query (no parameters).

Implementation: `getCopyTradingAsset()`

## Position (Private — Auth Required)

### GET /api/v1/futures/position/get_pending_positions
Get open positions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| positionId | string | optional | Filter by position ID |

Implementation: `getPendingPositions({ symbol, positionId })`

---

### GET /api/v1/futures/position/get_history_positions
Get closed/historical positions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| positionId | string | optional | Filter by position ID |
| startTime | number | optional | Start time, unix ms |
| endTime | number | optional | End time, unix ms |
| skip | number | optional | Default 0 |
| limit | number | optional | Default 10 |

Implementation: `getHistoryPositions({ symbol, positionId, startTime, endTime, skip = 0, limit = 10 })`

Response: `{ positionList: [ ... ] }`, or a bare array on some accounts.

| Field | Type | Description |
|-------|------|-------------|
| positionId | string | Position id |
| symbol | string | Trading pair |
| entryPrice | string | Average entry price |
| closePrice | string | Average close price (null on a partially closed position) |
| side | string | LONG \| SHORT |
| leverage | int32 | Leverage |
| fee | string | **Deducted** transaction fees during the position. Positive = a cost taken out of the position. |
| funding | string | Total funding fee during the position. Negative = paid by the position, positive = received. |
| realizedPNL | string | **Realized PnL — EXCLUDES funding fee and transaction fee.** |
| liqPrice | string | Estimated liquidation price; ≤ 0 means there is no liquidation price |
| ctime / mtime | int64 | Create / latest modify timestamp (unix ms) |

> Net result = `realizedPNL - fee + funding`. Because `realizedPNL` excludes
> both, adding the fee back instead of subtracting it overstates performance by
> twice the commission. Both `manager.js` paths use the formula above.

---

### GET /api/v1/futures/position/get_position_tiers
Get position risk tiers (maintenance margin rate per notional band).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |

Implementation: `getPositionTiers({ symbol })`

Response: array of `{ level, startValue, endValue, leverage, maintenanceMarginRate }`

## Trade (Private — Auth Required)

### POST /api/v1/futures/trade/place_order
Place a futures order.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair, e.g. "BTCUSDT" |
| marginCoin | string | yes | Margin coin, default "USDT" **(must be sent)** |
| qty | string | yes | Order quantity in base coin |
| side | string | yes | "BUY" or "SELL" — names the POSITION, not order direction |
| orderType | string | optional | "LIMIT" or "MARKET", default "MARKET" |
| price | string | optional | Required for LIMIT orders |
| tradeSide | string | optional | "OPEN" or "CLOSE" (hedge mode), default "OPEN" |
| positionId | string | optional | Required when tradeSide is CLOSE |
| effect | string | optional | Time in force: "GTC", "IOC", "FOK", "POST_ONLY", default "GTC" |
| reduceOnly | boolean | optional | Reduce-only flag |
| clientId | string | optional | Client order ID |
| tpPrice | string | optional | Take-profit trigger price |
| tpStopType | string | optional | "MARK_PRICE" or "LAST_PRICE", default "MARK_PRICE" |
| tpOrderType | string | optional | "LIMIT" or "MARKET", default "MARKET" |
| tpOrderPrice | string | optional | TP order price (required if tpOrderType is LIMIT) |
| slPrice | string | optional | Stop-loss trigger price |
| slStopType | string | optional | "MARK_PRICE" or "LAST_PRICE", default "MARK_PRICE" |
| slOrderType | string | optional | "LIMIT" or "MARKET", default "MARKET" |
| slOrderPrice | string | optional | SL order price (required if slOrderType is LIMIT) |

Implementation: `placeOrder(params)` in `src/exchange/bitunix.js`

**HEDGE mode mapping**:
- Open long: side "BUY", tradeSide "OPEN"
- Open short: side "SELL", tradeSide "OPEN"
- Close long: side "BUY", tradeSide "CLOSE" + positionId
- Close short: side "SELL", tradeSide "CLOSE" + positionId

**⚠️ `side` names the POSITION, not order direction.** Closing a long is a BUY, not a SELL.

**Order unit**: API only accepts base coin (qty). Use `sizeOrder()` to convert COST/NOMINAL/QTY to qty.

### POST /api/v1/futures/trade/batch_order
Place batch orders (max 20).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| orderList | array | yes | Array of order objects |

Implementation: `batchOrder({ symbol, orderList })`

---

### POST /api/v1/futures/trade/cancel_orders
Cancel one or more orders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| orderList | array | yes | Array of { orderId?, clientId? }, min 1, max 20 |
| marginCoin | string | optional | Default "USDT" **(must be sent)** |

Implementation: `cancelOrders({ symbol, orderList, marginCoin })`

---

### POST /api/v1/futures/trade/cancel_all_orders
Cancel all orders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| marginCoin | string | optional | Default "USDT" **(must be sent)** |

Implementation: `cancelAllOrders({ symbol, marginCoin })`

---

### POST /api/v1/futures/trade/close_all_position
Close all positions (market close).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |

Implementation: `closeAllPositions({ symbol })`

---

### POST /api/v1/futures/trade/flash_close_position
Flash close a position (market close by positionId).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| positionId | string | yes | Position ID |
| marginCoin | string | optional | Default "USDT" **(must be sent)** |

Implementation: `flashClosePosition(positionId, marginCoin)`

---

### GET /api/v1/futures/trade/get_pending_orders
Get open orders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| orderId | string | optional | Filter by order ID |
| clientId | string | optional | Filter by client ID |
| status | string | optional | "NEW" or "PART_FILLED" |
| startTime | number | optional | Start time, unix ms |
| endTime | number | optional | End time, unix ms |
| skip | number | optional | Default 0 |
| limit | number | optional | Default 50, max 100 |
| marginCoin | string | optional | Default "USDT" **(must be sent)** |

Implementation: `getPendingOrders({ symbol, orderId, clientId, status, startTime, endTime, skip, limit, marginCoin })`

### GET /api/v1/futures/trade/get_history_orders
Get historical orders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| orderId | string | optional | Filter by order ID |
| clientId | string | optional | Filter by client ID |
| status | string | optional | Filter by status |
| type | string | optional | Filter by order type |
| startTime | number | optional | Start time, unix ms |
| endTime | number | optional | End time, unix ms |
| skip | number | optional | Default 0 |
| limit | number | optional | Default 20 |
| marginCoin | string | optional | Default "USDT" **(must be sent)** |

Implementation: `getHistoryOrders(...)`

---

### GET /api/v1/futures/trade/get_history_trades
Get historical trades (fills).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| orderId | string | optional | Filter by order ID |
| positionId | string | optional | Filter by position ID |
| startTime | number | optional | Start time, unix ms |
| endTime | number | optional | End time, unix ms |
| skip | number | optional | Default 0 |
| limit | number | optional | Default 20 |
| marginCoin | string | optional | Default "USDT" **(must be sent)** |

Implementation: `getHistoryTrades(...)`

---

### GET /api/v1/futures/trade/get_order_detail
Get detail for a single order.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| orderId | string | optional | Order ID |
| clientId | string | optional | Client order ID |

Implementation: `getOrderDetail({ orderId, clientId })`

## TP/SL (Private — Auth Required)

### POST /api/v1/futures/tpsl/position/place_order
Place position-level TP/SL (closes whole position at market).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| positionId | string | yes | Position ID |
| tpPrice | string | optional | Take-profit price |
| tpStopType | string | optional | "MARK_PRICE" or "LAST_PRICE", default "MARK_PRICE" |
| slPrice | string | optional | Stop-loss price |
| slStopType | string | optional | "MARK_PRICE" or "LAST_PRICE", default "MARK_PRICE" |

Implementation: `placePositionTpSl({ symbol, positionId, tpPrice, tpStopType, slPrice, slStopType })`

---

### POST /api/v1/futures/tpsl/position/modify_order
Modify position-level TP/SL.

Same parameters as place_order.

Implementation: `modifyPositionTpSl({ symbol, positionId, tpPrice, tpStopType, slPrice, slStopType })`

---

### POST /api/v1/futures/tpsl/place_order
Place partial TP/SL with qty.

Implementation: `placeTpSlOrder(params)` — pass-through to API.

---

### POST /api/v1/futures/tpsl/modify_order
Modify partial TP/SL order.

Implementation: `modifyTpSlOrder(params)` — pass-through to API.

---

### POST /api/v1/futures/tpsl/cancel_order
Cancel a TP/SL order.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | yes | Trading pair |
| orderId | string | yes | TP/SL order ID |

Implementation: `cancelTpSlOrder({ symbol, orderId })`

---

### GET /api/v1/futures/tpsl/get_pending_orders
Get pending TP/SL orders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| positionId | string | optional | Filter by position ID |
| side | number | optional | int32 (not BUY/SELL strings!) |
| positionMode | number | optional | int32 |
| skip | number | optional | Default 0 |
| limit | number | optional | Default 50, max 100 |

Implementation: `getPendingTpSlOrders({ symbol, positionId, side, positionMode, skip, limit })`

⚠️ `side` and `positionMode` are int32 in the docs, not BUY/SELL strings. Callers pass only {symbol, positionId} and filter client-side.

---

### GET /api/v1/futures/tpsl/get_history_orders
Get historical TP/SL orders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| symbol | string | optional | Filter by symbol |
| side | number | optional | int32 |
| positionMode | number | optional | int32 |
| startTime | number | optional | Start time, unix ms |
| endTime | number | optional | End time, unix ms |
| skip | number | optional | Default 0 |
| limit | number | optional | Default 20 |

Implementation: `getHistoryTpSlOrders({ symbol, side, positionMode, startTime, endTime, skip, limit })`

## Error Codes

From https://www.bitunix.com/api-docs/futures/ErrorCode/error_code.html

| Code | Meaning |
|------|---------|
| 0 | Success |
| 10001 | Network Error (retryable) |
| 10002 | Parameter Error |
| 10003 | api-key can't be empty |
| 10004 | IP not in whitelist |
| 10005 | Too many requests (retryable) |
| 10006 | Request too frequently (retryable) |
| 10007 | Sign signature error |
| 10008 | Value does not comply with rule |
| 20001 | Market not exists |
| 20002 | Positions exceeded max open limit |
| 20003 | Insufficient balance |
| 20005 | Invalid leverage |
| 20006 | Can't change leverage/margin with open orders |
| 20007 | Order not found |
| 20008 | Insufficient amount |
| 20009 | Position exists, position mode cannot be updated |
| 20011 | Account not allowed to trade |
| 20012 | This futures does not allow trading |
| 30001 | Failed to order — adjust price or leverage |
| 30002 | Price below liquidation price |
| 30003 | Price above liquidation price |
| 30004 | Position not exist |
| 30011 | Abnormal order status |
| 30013 | Exceeded max order quantity |
| 30016 | Qty should be larger than minimum |
| 30017 | Qty cannot be less than minimum qty |
| 30040 | Futures trading prohibited |
| 40001 | Cancel open orders and close all positions before canceling lead trading |
| 40007 | Share settlement in progress (retryable) |

Retryable codes: 10001, 10005, 10006, 40007.

Implementation: `src/exchange/errors.js`

## Order Statuses

| Status | Meaning |
|--------|---------|
| INIT | Initial |
| NEW | New order |
| PART_FILLED | Partially filled |
| PART_FILLED_CANCELED | Partially filled, remainder canceled **(real fill)** |
| CANCELED | Canceled |
| FILLED | Fully filled |
| EXPIRED | Expired |

`orderGotFill()` returns true for PART_FILLED, PART_FILLED_CANCELED, FILLED.
`orderIsTerminal()` returns true for FILLED, CANCELED, PART_FILLED_CANCELED, EXPIRED.
`orderRejected()` returns true for CANCELED, EXPIRED.

Implementation: `src/exchange/errors.js`

## Order Units (from help centre id=170)

Three units describing the same position:

| Unit | Formula | Example (100 USDT, 10x, price 10000) |
|------|---------|--------------------------------------|
| COST | qty = cost × leverage ÷ price | qty = 100 × 10 ÷ 10000 = 0.1 |
| NOMINAL | qty = nominal ÷ price | qty = 1000 ÷ 10000 = 0.1 |
| QTY | base coin directly | 0.1 BTC at 10000 → nominal 1000 USDT |

The exchange API only accepts base coin (qty). `sizeOrder()` converts any unit to qty.

Implementation: `sizeOrder()`, `qtyFromCost()`, `describeUnits()` in `src/exchange/bitunix.js`

## Liquidation Price (Isolated Margin)

```
Long:  Liq = Entry × (1 - 1/Leverage + MMR)
Short: Liq = Entry × (1 + 1/Leverage - MMR)
```

MMR = maintenance margin rate from `get_position_tiers`.

Stop must be clamped inside liquidation: `clampStopInsideLiq()`

Implementation: `estimateLiqPrice()` in `src/trading/risk.js`

## MCP Tool Schemas (Zod)

From `bitunix-mcp/src/schemas.ts`:

| Schema | Validation |
|--------|------------|
| symbolSchema | Uppercase alphanumeric, 2-20 chars, e.g. "BTCUSDT" |
| coinSchema | Uppercase alphanumeric, 1-15 chars, e.g. "USDT" |
| decimalSchema | Positive decimal string, e.g. "0.001" |
| orderIdSchema | Alphanumeric with _ and -, 1-64 chars |
| timestampMsSchema | Positive integer, max 9999999999999 |
| futuresIntervalSchema | 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M |
| spotIntervalSchema | 1, 3, 5, 15, 30, 60, 120, 240, 360, 720, D, M, W |
| sideSchema | "BUY" \| "SELL" |
| futuresOrderTypeSchema | "LIMIT" \| "MARKET" |
| effectSchema | "GTC" \| "IOC" \| "FOK" \| "POST_ONLY" |
| tradeSideSchema | "OPEN" \| "CLOSE" |
| stopTypeSchema | "MARK_PRICE" \| "LAST_PRICE" |

## MCP Registered Tools

### Futures (Read-only, always available):
- futures_get_tickers
- futures_get_depth
- futures_get_kline
- futures_get_funding_rate
- futures_get_trading_pairs
- futures_get_account
- futures_get_positions
- futures_get_history_positions
- futures_get_pending_orders
- futures_get_history_orders

### Futures Trading (only when BITUNIX_ENABLE_TRADING=true):
- futures_place_order
- futures_cancel_orders

### Spot (Read-only):
- spot_get_last_price
- spot_get_depth
- spot_get_kline
- spot_get_trading_pairs
- spot_get_account
- spot_get_pending_orders
- spot_get_order_history
- spot_get_order_detail

### Spot Trading (only when BITUNIX_ENABLE_TRADING=true):
- spot_place_order
- spot_cancel_orders
