# Project Instructions — Bitunix AI Agent Trader

## What this is
An **agentic AI futures trader** for Bitunix USDT-M perpetuals — not a scripted bot.
It runs a think → call tools → observe → decide loop with ten independent strategies,
a regime-weighted consensus, an LLM verdict, and live TP/SL management. Control is
Telegram + MCP. **There is no dry-run mode — every order is real money.**

## Tech Stack
| Layer | Technology |
|---|---|
| Runtime | Node.js ≥20, ES Modules (`"type": "module"`) |
| Exchange | Bitunix Futures REST + WebSocket |
| Database | PostgreSQL on Neon (`pg`) — long-term memory + live `agent_settings` |
| Agent | Multi-provider LLM (OpenAI / Gemini / Anthropic) with AUTO detection + failover |
| Interfaces | Telegram bot + MCP server (JSON-RPC stdio, zero-dep) |
| Testing | Bare `assert`, `node tests/run.js` (no framework) |

Only 3 runtime deps: `dotenv`, `pg`, `ws`.

## Boot sequence (src/index.js)
migrate → seedSettings → loadSettings → Bitunix auth check → AI model refresh →
MCP tools → WS feed start → Telegram bot → Orchestrator.start (5 self-rescheduling loops).

## Code Style
- **ES modules**: all internal imports are relative with `.js` extension
  (e.g. `import bitunix from './exchange/bitunix.js'`).
- **Named exports** dominate (`export function`, `export const`, `export async function`);
  classes are default-exported.
- **File naming**: `camelCase` source modules (`bitunix.js`, `tpsl.js`, `indicators.js`),
  `kebab-case` test files (`test-consensus.js`, `test-trailing.js`).
- **Strategy keys** are `snake_case` (`trend_supertrend`); JS function names `camelCase` (`trendSupertrend`).
- **No linter/formatter** is configured — match surrounding style on edits.

## Critical Rules — NEVER violate these
These are enforced because real money is on the line. See `SKILL.md` and
`analysis_outputs/RISKS.md`.

- **All** Bitunix API calls go through `src/exchange/bitunix.js` (never the exchange directly).
- Parameter names must match the official docs verbatim; see `BITUNIX_API_PARAMETERS.md`.
- Send `marginCoin` on all trade endpoints.
- Check order status after placing — `PART_FILLED_CANCELED` is a real fill.
- Kline price-type selector is `type` (`LAST_PRICE` | `MARK_PRICE`), **not** `klineType`.
- WS minute kline channel names need the `min` suffix: `market_kline_1min`, not `market_kline_1m`.
- WS: ping every 5s, 250ms pump → max 4 msg/s out, 300 sub cap in batches of 20.
- Retry only on transient codes `10001/10005/10006/40007`; all else throws.
- Rate limit: 8 req/s internal throttle (docs allow 10).
- **Every stop is clamped inside liquidation** via `clampStopInsideLiq()` with a
  fee-band floor (`min_stop_pct`); a stop that cannot fit inside liq distance at the
  configured leverage refuses the trade rather than shrinking the position.
- MCP trading tools stay off unless `BITUNIX_ENABLE_TRADING=true`.
- API credentials are redacted from error/log output.
- `.env` is only a **seed** — live trading params live in Neon `agent_settings`, editable
  at runtime from Telegram (`/set`). If a row exists in Neon, `.env` trading values
  have no effect. `config.js` enforces `.env` wins over process env for critical keys.

## Testing
- Run all: `npm test` (`node tests/run.js`).
- Run one suite: `node tests/run.js consensus` (matches any `test-*.js` substring).
- Tests are standalone scripts — bare `assert` with `ok`/`FAIL` logging, `passed`/`failed`
  counters, `close()` float comparator. Write new tests in that same minimal style.
- Tests target pure functions (scanner, consensus, risk, TP/SL, sign) with synthetic
  multi-TF data — no network. The DB module degrades to neutral defaults offline.

## Build & Run
```bash
npm install
cp .env.example .env && $EDITOR .env   # fill keys (106-line authoritative reference)
npm run doctor        # verify env, Neon, Bitunix auth, AI, Telegram — NOT optional
npm run migrate       # create Neon schema
npm start             # node src/index.js — LIVE, real money
```
- Pre-flight: `npm run doctor` validates Bitunix signature, Neon connection, and AI keys.
- MCP server: `npm run mcp`; test it: `npm run mcp:test`; config: `npm run mcp:config`.

## Project Structure
```
src/
  index.js            # boot + shutdown
  config.js           # .env → config; enforces .env authority over process env
  logger.js
  orchestrator.js     # 5 self-rescheduling loops (scan/manage/guard/report/autonomous/dream)
  settings-schema.js  # runtime settings schema + defaults (live values in Neon)
  scanner/scanner.js  # buildUniverse → analyseSymbol → runAll(10 strategies) → consensus
  strategies/         # index.js (registry + 10 strategies) | indicators.js (TA helpers)
  exchange/           # bitunix.js (REST client) | sign.js | errors.js | ws.js (feeds)
  trading/            # executor.js | manager.js | risk.js | tpsl.js
  ai/                 # agent.js | analysis-agent.js | providers.js | tools.js | soul.js | dream.js
  telegram/           # bot.js | commands.js | format.js
  mcp/                # server.js (JSON-RPC stdio) | client.js (external MCP servers)
  db/                 # index.js | migrate.js | schema.sql
scripts/              # doctor.js | mcp-config.js | mcp-test.js | wf-trailing.mjs
.claude/workflows/    # diagnose-trailing-failures.js
soul/                 # SOUL.md (philosophy) | STYLE.md | SKILL.md | skills/
tests/test-*.js       # 17 suites (pure functions, no network)
*.md                  # README | SKILL.md | BITUNIX_API_PARAMETERS.md | official-endpoints-bitunix.md
```

## Signal Lifecycle
`scanLoop` → `scan()` → `buildUniverse()` → `analyseSymbol()` → `runAll()` (10 strats) →
`consensus()` (regime-weighted, agreement ≥ `min_agreement`, confidence ≥ `min_confidence`) →
LLM `agent.js` verdict (market context via tools) → `executor.openFromSignal()` (qty from margin_pct,
liq-clamped stop, fee-band floor) → `bitunix.placeOrder()` + `upsertPositionTpSl` →
`manager.js` (breakeven → ATR-trail → reversal) every 15s.

## Key Settings (runtime, in Neon `agent_settings`; `/set key value`)
`auto_trade`, `leverage` (10), `margin_mode` (CROSS), `position_mode` (HEDGE),
`order_unit` (COST), `margin_pct` (5), `timeframes` (1m,3m,5m,15m), `min_agreement` (2),
`min_confidence` (80), `tf_min_confidence` (60), `signal_confirm_scans` (1), `cooldown_min` (5),
`reversal_enabled`, `reversal_confidence` (85), `breakeven_threshold` (20),
`trailing_trigger_roi_pct` (25), `trailing_distance_atr` (0.5), `liq_distance` (0.50),
`min_stop_pct` (0.25), `max_open_positions` (5), `universe_rank` (VOLUME), `universe_size` (40),
`min_24h_volume_usd` (20000000), `tp_mode` (ADAPTIVE), `tpsl_method` (POSITION),
`trailing_method` (ATR), `scan_interval_sec`, `manage_interval_sec`, `guard_interval_sec`,
`report_interval_sec`, `agent_autonomous_sec`, `thinking_level` (high), `dream_enabled`.

## Where to add features
| I want to... | Go to... |
|---|---|
| Add a Bitunix REST endpoint | `src/exchange/bitunix.js` (+ document in `BITUNIX_API_PARAMETERS.md` + MCP tool in `src/ai/tools.js`) |
| Add a strategy | `src/strategies/index.js` (fn + add to `STRATEGIES` array); indicators in `src/strategies/indicators.js` |
| Change TP/SL | `src/trading/tpsl.js` + `src/trading/risk.js` (stop sizing / liq clamp / fee floor) |
| Add a Telegram command | `src/telegram/commands.js` |
| Change/add a runtime setting | `src/settings-schema.js` (then `/set` writes to Neon) |
| Expose a tool over MCP | register in `TOOLS`/`TOOL_MAP` in `src/ai/tools.js` (consumed by `src/mcp/server.js`) |
| Test a change | new `tests/test-*.js` (bare `assert`); run `node tests/run.js <name>` |
