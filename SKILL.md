---
name: bitunix-development
description: "**WORKFLOW SKILL** — Develop, debug, and deploy features for Bitunix-ai-trader, an agentic AI futures trader for Bitunix USDT-M perpetuals. USE FOR: implementing new trading strategies, adding Bitunix API endpoints, extending MCP tools, configuring TP/SL methods, creating Telegram commands, adding risk guards, deploying the agent. USE WHEN: building crypto trading features, exchange API integration, signal detection systems, or production deployment of the Bitunix agent. DO NOT USE FOR: non-crypto applications, simple CRUD apps without trading logic, or projects not using Node.js + Bitunix API stack."
---

# Bitunix-ai-trader Development Workflow

## Project Context

**Bitunix-ai-trader** is an agentic AI futures trader for Bitunix USDT-M perpetuals — not a scripted bot. It runs a reasoning loop (think → call tools → observe → decide) with access to the order book, funding rates, trade history, and long-term memory in Neon. It talks via Telegram and exposes all tools over MCP.

### Technology Stack

- **Runtime**: Node.js ≥20 (ES modules)
- **Exchange API**: Bitunix Futures REST + WebSocket (fapi.bitunix.com)
- **Database**: PostgreSQL (Neon) via `pg`
- **Real-time**: WebSocket (`ws`) for public and private channels
- **Agent**: Multi-provider LLM (OpenAI-compatible / Gemini / Anthropic) with auto failover
- **Interface**: Telegram bot + MCP server (for Claude Desktop, Cursor, Cline, etc.)
- **Deployment**: Docker, systemd, or direct `node src/index.js`

### Core Architecture

```
Telegram / MCP client → Orchestrator → Scanner (10 strategies) → Consensus → Executor
                                              ↓
                                      Bitunix REST API (signed)
                                              ↓
                                      Neon (long-term memory)
```

## Development Workflow

### Step 1: Understand the Feature Scope

When implementing a feature, first identify:

1. **Feature Category**:
   - 📊 **Market data** → Bitunix REST ticker/depth/kline/funding endpoints
   - 🤖 **AI prediction** → LLM provider integration + strategy signals
   - 📈 **Technical analysis** → Indicator calculation (RSI, MACD, Bollinger, ATR, EMA, Supertrend, VWAP, volume profile)
   - 🎯 **Signal detection** → Pattern recognition + consensus scoring
   - 🛡️ **Risk management** → Liquidation-aware stops, position sizing, TP/SL
   - 🔧 **Exchange integration** → New MCP tools, REST endpoints, WebSocket channels
   - 🖥️ **UI/Dashboard** → Telegram commands + message formatting

2. **Data Flow**:
   - Does it need Bitunix API data? → Use `src/exchange/bitunix.js` client (never call the exchange directly)
   - Real-time updates? → Implement WebSocket in `src/exchange/ws.js`
   - Historical data? → Query Neon via `src/db/index.js`
   - Cross-component state? → Use settings in Neon (`agent_settings` table)
   - MCP tool? → Register in `bitunix-mcp/src/tools/futures.ts` or `spot.ts`

3. **Performance Requirements**:
   - Rate limiting: 8 req/sec internal throttle (docs allow 10/sec)
   - Circuit breaker: retry on 10001/10005/10006/40007 only (transient)
   - Cache TTL: Pair info 10 min, position tiers 6 hours

### Step 2: Backend Implementation

#### 2.1 Add a New Bitunix API Endpoint (Exchange Client)

**Location**: `src/exchange/bitunix.js`

**Template**:
```javascript
// GET /api/v1/futures/market/your_endpoint
getYourEndpoint({ symbol, ...params } = {}) {
  return this._get('/api/v1/futures/market/your_endpoint', params, false);
}

// POST /api/v1/futures/trade/your_endpoint   (signed, requires auth)
postYourEndpoint({ symbol, ...params } = {}) {
  return this._post('/api/v1/futures/trade/your_endpoint', params);
}
```

**⚠️ Critical Rules**:
- Every endpoint must be a 1:1 mapping of the official Bitunix documentation
- Parameter names must match the docs verbatim (see `BITUNIX_API_PARAMETERS.md`)
- Public endpoints use `auth = false`; private endpoints use `auth = true`
- Always send `marginCoin` on trade endpoints
- Order status must be checked after placing — `PART_FILLED_CANCELED` is a real fill
- The kline price-type selector is `type` (LAST_PRICE | MARK_PRICE), not `klineType`
- Query params are sorted by key for signing; body is raw compact JSON

#### 2.2 Register a New MCP Tool

**Location**: `bitunix-mcp/src/tools/futures.ts` (or `spot.ts`)

**Template**:
```typescript
server.registerTool(
  "futures_your_tool",
  {
    title: "Futures: your tool",
    description: "Human-readable description.",
    inputSchema: {
      symbol: symbolSchema,
    },
  },
  async ({ symbol }) => {
    const params: QueryParams = {};
    if (symbol) params.symbol = symbol;
    return jsonResult(await client.publicGet(FUTURES_BASE_URL, "/api/v1/futures/market/your_endpoint", params));
  }
);
```

**⚠️ Critical Rules**:
- Use zod schemas from `schemas.ts` for all input validation
- Trading tools are gated behind `config.tradingEnabled`
- API credentials are never accepted as tool arguments — they come from server env only
- Error messages must be redacted before reaching the client
- All tools return `{ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }`

#### 2.3 Add a New Trading Strategy

**Location**: `src/strategies/`

**Template**:
```javascript
export function yourStrategy({ candles, atr, rsi, ... }) {
  return { signal: 'LONG' | 'SHORT' | 'NEUTRAL', confidence: 0-100, reason: '...' };
}
```

**Registration**: Add to `src/strategies/index.js` and the orchestrator consensus weights.

**⚠️ Critical Rules**:
- Strategies must be deterministic — same inputs, same outputs
- Use only data available at decision time (no lookahead)
- Confidence must be 0-100

#### 2.4 Add a New TP/SL Method

**Location**: `src/trading/tpsl.js`

Four methods documented in Bitunix help centre id=290:
1. **Position** — one TP/SL closes the whole position (native API)
2. **Partial** — several triggers, each closing a share (native API with qty)
3. **Trailing** — arms at activation, trails behind price (software + native floor)
4. **Account** — closes all positions when total PnL crosses threshold (software)

**⚠️ Critical Rules**:
- Methods 3 and 4 have no native API endpoint — implemented in software
- Software stops only work while the manage loop is running
- Every stop must be clamped inside liquidation price via `clampStopInsideLiq()`

### Step 3: Frontend / Interface Implementation

#### 3.1 Add a Telegram Command

**Location**: `src/telegram/commands.js`

**Template**:
```javascript
commands.your_command = {
  description: 'What it does',
  handler: async (chatId, args) => {
    return 'Response message';
  },
};
```

**⚠️ Critical Rules**:
- Only `TELEGRAM_ALLOWED_CHAT_IDS` can command the agent
- No dry-run mode — every order is real money

#### 3.2 Format a Message

**Location**: `src/telegram/format.js`

Use helper functions for consistent formatting.

#### 3.3 Real-time WebSocket (MarketFeed)

**Location**: `src/exchange/ws.js`

Two sockets: public (`config.bitunix.wsPublic`) and private (`config.bitunix.wsPrivate`). `MarketFeed` aggregates tickers, positions and balance, with REST as the source of truth.

- **Public channels (per-symbol)**: `ticker`, `trade`, `depth_book1` / `depth_books`, `market_kline_<n>min`
- **Private channels**: `balance`, `position`, `order`, `tpsl`

**⚠️ Critical Rules**:
- Outgoing rate limit: max 5 messages/sec (ping/pong counts) — the client throttles to 4/sec via a 250ms pump
- Max 300 channel subscriptions per connection; subscribe in batches of 20
- WebSocket: reconnect with exponential backoff (1s → 30s cap); resubscribe on reconnect
- Ping every 5s — the server drops silent sessions (~26s, code 1006)
- The symbol-less `{ch:'tickers'}` channel is unusable (one delta batch, then quiet); use per-symbol `ticker` via `watchSymbols()`
- Minute kline channel names need the `min` suffix: `market_kline_1min`, not `market_kline_1m`

### Step 4: Deployment

#### 4.1 Pre-Deployment Checklist

- [ ] `npm run doctor` passes (env, Neon, Bitunix auth, AI, Telegram)
- [ ] `npm run migrate` applied to Neon schema
- [ ] All env vars set in production
- [ ] `BITUNIX_ENABLE_TRADING` explicitly set (MCP trading tools stay off unless `true`)
- [ ] WebSocket connection tested (both public and private)
- [ ] Rate limit respected (8 req/sec internal throttle)
- [ ] API credentials redacted from logs/errors

#### 4.2 Deployment Process

**Direct** (simplest):
```bash
npm install
cp .env.example .env && $EDITOR .env
npm run doctor && npm run migrate
npm start          # node src/index.js
```

**systemd** (recommended for always-on):
```ini
# /etc/systemd/system/bitunix-ai-trader.service
[Unit]
Description=Bitunix AI Trader
After=network.target

[Service]
WorkingDirectory=/opt/bitunix-ai-trader
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/bitunix-ai-trader/.env

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bitunix-ai-trader
journalctl -u bitunix-ai-trader -f
```

**Docker** (no Dockerfile ships in the repo — add one if containerizing):
```bash
docker build -t bitunix-ai-trader .
docker run -d --env-file .env --restart unless-stopped bitunix-ai-trader
```

#### 4.3 Common Deployment Issues

- **WS closes with code 1006**: server drops sessions that don't ping — ensure `_startPing()` runs (every 5s)
- **Private login fails**: check `signWs()` (`api-key`/`nonce`/`timestamp`) and that the key has futures permissions
- **Order rejected**: verify `marginCoin` is sent and the stop is clamped inside liquidation
- **Neon connection fails**: confirm `DATABASE_URL` uses `sslmode=require`
- **Anyone can trade the account**: set `TELEGRAM_ALLOWED_CHAT_IDS`; use an API key without withdrawal permission + IP whitelist

### Quality Checklist

Before committing:

- [ ] All Bitunix API calls go through `src/exchange/bitunix.js`
- [ ] Parameter names match official docs verbatim
- [ ] `marginCoin` is sent on all trade endpoints
- [ ] Order status is checked after placing orders
- [ ] `PART_FILLED_CANCELED` is handled as a real fill
- [ ] Kline price type uses `type` (LAST_PRICE | MARK_PRICE)
- [ ] MCP tool inputs validated with zod schemas from `schemas.ts`
- [ ] Trading tools gated behind `BITUNIX_ENABLE_TRADING=true`
- [ ] API credentials redacted from error messages
- [ ] Stops clamped inside liquidation price
- [ ] Environment variables added to `.env.example`
- [ ] Rate limit respected (8 req/sec internal throttle)

Before deploying:

- [ ] `npm run doctor` passes
- [ ] `npm run migrate` applied to Neon schema
- [ ] All env vars set in production
- [ ] Build/lint passes

## Key Files Reference

| Purpose | Path |
|---------|------|
| Entry point | `src/index.js` |
| Config | `src/config.js` |
| Exchange client | `src/exchange/bitunix.js` |
| Request signing | `src/exchange/sign.js` |
| Error codes | `src/exchange/errors.js` |
| WebSocket | `src/exchange/ws.js` |
| MCP server | `src/mcp/server.js` |
| MCP client | `src/mcp/client.js` |
| MCP futures tools | `bitunix-mcp/src/tools/futures.ts` |
| MCP spot tools | `bitunix-mcp/src/tools/spot.ts` |
| MCP schemas | `bitunix-mcp/src/schemas.ts` |
| MCP HTTP client | `bitunix-mcp/src/http.ts` |
| MCP signing | `bitunix-mcp/src/sign.ts` |
| MCP config | `bitunix-mcp/src/config.ts` |
| Strategies | `src/strategies/index.js` |
| Indicators | `src/strategies/indicators.js` |
| Scanner | `src/scanner/scanner.js` |
| Orchestrator | `src/orchestrator.js` |
| Executor | `src/trading/executor.js` |
| Risk | `src/trading/risk.js` |
| TP/SL | `src/trading/tpsl.js` |
| Manager | `src/trading/manager.js` |
| Settings schema | `src/settings-schema.js` |
| Database | `src/db/index.js` |
| Migration | `src/db/migrate.js` |
| Telegram bot | `src/telegram/bot.js` |
| Telegram commands | `src/telegram/commands.js` |
| Telegram format | `src/telegram/format.js` |
| AI agent | `src/ai/agent.js` |
| AI tools | `src/ai/tools.js` |
| AI providers | `src/ai/providers.js` |
| AI dream | `src/ai/dream.js` |
| AI soul | `src/ai/soul.js` |
| Logger | `src/logger.js` |
| Environment example | `.env.example` |

## Example Workflows

### Adding a New Bitunix REST Endpoint

1. Add method to `src/exchange/bitunix.js`
2. Register MCP tool in `bitunix-mcp/src/tools/futures.ts`
3. Add zod schema to `bitunix-mcp/src/schemas.ts` if needed
4. Document endpoint in `BITUNIX_API_PARAMETERS.md`
5. Test via MCP client or exchange client

### Adding a New Trading Signal

1. Create strategy file in `src/strategies/`
2. Register in `src/strategies/index.js` and orchestrator weights
3. Add indicator to `src/strategies/indicators.js` if needed
4. Test scanner against historical data

### Adding a New MCP Tool (Read-Only)

1. Add/reuse zod schema in `bitunix-mcp/src/schemas.ts`
2. Register tool in `bitunix-mcp/src/tools/futures.ts`
3. Ensure `src/exchange/bitunix.js` has the underlying method
4. Start MCP server and call tool via MCP client

## Quick Commands Reference

```bash
npm start                     # Start the live agent
npm test                      # Run tests
npm run doctor                # Verify env, Neon, Bitunix auth, AI, Telegram
npm run migrate               # Create Neon schema
npm run mcp                   # Start MCP server
npm run mcp:test              # Test MCP server
npm run mcp:config            # Generate MCP config

cp .env.example .env          # Copy example env
$EDITOR .env                  # Fill in keys