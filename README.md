# 🤖 Bitunix AI Agent Trader

An **agentic AI futures trader** for Bitunix USDT-M perpetuals — not a bot.

A rule-based bot runs a fixed script. This runs a reasoning loop: it scans the
market with six independent strategies, forms a weighted consensus, and then an
LLM with a full tool belt decides — with access to the order book, funding,
your own trade history and its long-term memory — whether the trade is actually
worth taking. It talks to you in Telegram like a colleague, remembers what it
learned in Neon, and exposes everything over MCP.

> ⚠️ **LIVE TRADING ONLY.** There is no dry-run, paper or simulation mode
> anywhere in this codebase, by design. Every order is real money.

---

## What it does

| | |
|---|---|
| **Agentic, not scripted** | A real think → call tools → observe → decide loop with configurable thinking depth |
| **6 strategies** | Trend, momentum, squeeze breakout, VWAP reversion, EMA pullback, order-flow/funding |
| **Regime-aware consensus** | Strategies are weighted by market regime, timeframe, *and* their live realised performance |
| **Fully dynamic TP/SL** | ATR × signal strength. No fixed percentages, no min/max knobs — nothing to tune |
| **Live protection** | Auto-attaches missing TP/SL, moves to breakeven, then ATR-trails winners |
| **Reversal engine** | Flips a position when the opposite side clears the reversal threshold |
| **Neon long-term memory** | Conversations, lessons, trades, per-strategy weights, cooldowns — it learns |
| **Multi-provider AI** | OpenAI-compatible / Gemini / Anthropic with AUTO model detection and failover |
| **MCP server** | The whole tool belt available to Claude Desktop, Cursor, Cline, other agents |
| **Telegram** | Full command set *and* free-form conversation |

---

## Quick start

```bash
git clone <your-repo> bitunix-ai-trader
cd bitunix-ai-trader
npm install

cp .env.example .env
$EDITOR .env          # fill in the keys

npm run doctor        # verify env, Neon, Bitunix auth, AI, Telegram
npm run migrate       # create the Neon schema
npm start             # 🚀 live
```

`npm run doctor` is not optional — it validates your Bitunix signature, your
Neon connection and your AI keys *before* real money is at stake.

---

## Configuration

Everything in `.env` is only a **seed**. The live values live in Neon
(`agent_settings`) and are changeable at runtime from Telegram with `/set`, or
by the agent itself. No restart needed — the loops pick up new intervals on
their next tick.

### Environment

```bash
AI_PROVIDER=AUTO                    # AUTO tries every provider that has a key

OPENAI_COMPATIBLE_KEY=
OPENAI_COMPATIBLE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_MODEL=AUTO        # AUTO = autoSetModelByKey()

GEMINI_GOOGLE_KEY=
GEMINI_GOOGLE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_GOOGLE_MODEL=AUTO

ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
ANTHROPIC_MODEL=AUTO

DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require

BITUNIX_API_KEY=
BITUNIX_API_SECRET=

TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=123456789    # set this, or anyone can trade your account
```

**`AUTO` model resolution — probe, don't guess.** A model appearing in
`/models` does **not** mean your key may call it (unverified org, wrong tier,
region, deprecated). So AUTO:

1. lists the models your key can see;
2. throws away anything that is not a chat model (embeddings, whisper, dall-e,
   moderation, rerank…);
3. ranks the rest, de-prioritising `mini`/`nano`/`preview` variants;
4. **actually calls** the top candidates with a tiny tool-calling request and
   keeps the first that answers;
5. blacklists the ones that rejected you, so they are never chosen again.

If a model dies mid-session (404 / "does not exist" / "must be verified"), the
router demotes it and retries the same request on the next candidate — the
agent keeps trading instead of going dark.

Set an explicit model in `.env` (e.g. `OPENAI_COMPATIBLE_MODEL=gpt-4o`) to pin
it. A pinned model is never auto-demoted: if it breaks, you get a loud error
rather than a silent downgrade.

**Relays and gateways** (one-api, new-api, LiteLLM, OpenRouter, self-hosted)
are first-class: model names there are whatever the operator configured, so the
router **never invents an id** — every candidate comes from the live `/models`
list. Unknown names are ranked by capability hints (`235b`, `sonnet`,
`reasoner`, `pro`…) so a flagship is tried before a 1B model, and
`available channels for model X in group default` is treated as "this model is
not usable" — it is blacklisted and the next one is tried automatically.

If nothing works you get an actionable error naming every model that was
rejected, instead of a silent fallback to a model that does not exist on your
endpoint. Run `/models list` to see exactly what your key can call.

### Runtime settings

| Setting | Default | Meaning |
|---|---|---|
| `auto_trade` | `true` | Master switch (`/pause`, `/resume`) |
| `leverage` | `10` | Applied per symbol before entry, clamped to the pair's tier |
| `margin_mode` | `CROSS` | `CROSS` or `ISOLATION` |
| `position_mode` | `HEDGE` | `HEDGE` or `ONE_WAY` |
| `order_unit` | `COST` | You size in **USDT margin**; qty is derived and rounded to `basePrecision` |
| `margin_pct` | `5` | % of available balance used as margin per trade |
| `symbols` | `AUTO` | `AUTO` = rank the **entire** exchange pair list by volume × range |
| `universe_size` | How many symbols AUTO keeps, best first. The other ~645 pairs are not scanned |
| `min_24h_volume_usd` | Liquidity floor (default $20M). Thinner pairs are never scanned |
| `timeframes` | `5m,15m,1h` | First one is the execution timeframe |
| `min_agreement` | `2` | Distinct strategies that must agree |
| `min_confidence` | `80` | Consensus confidence gate |
| `tf_min_confidence` | `60` | Per-timeframe gate for a strategy to get a vote |
| `signal_confirm_scans` | `1` | Consecutive scans required before acting |
| `cooldown_min` | `5` | Per-symbol cooldown after a trade |
| `reversal_enabled` | `true` | Flip on strong opposite signals |
| `reversal_confidence` | `85` | Threshold to flip |
| `breakeven_threshold` | `20` | ROI % at which the stop moves to breakeven |
| `trailing_trigger_roi_pct` | `25` | ROI % at which ATR trailing begins |
| `trailing_distance_atr` | How far behind price the trailing stop sits, in ATR (default 0.5) |
| `scan_interval_sec` | `15` | Scanner |
| `manage_interval_sec` | `15` | Mid-position management |
| `guard_interval_sec` | `15` | Protection pass |
| `report_interval_sec` | `30` | Telegram report (signals + PnL) |
| `agent_autonomous_sec` | `15` | Free-running agent initiative |
| `max_open_positions` | `5` | Concurrency cap |
| `thinking_level` | `high` | `off` / `low` / `medium` / `high` → 1/3/6/10 tool steps |
| `autocompact` | `true` | Folds old conversation into summaries |
| `auto_refresh_model` | `true` | Re-detects the model after failures |

```
/set min_confidence 85
/set margin_pct 3
/set symbols BTCUSDT,ETHUSDT,SOLUSDT
/set symbols AUTO
/set reversal_confidence 90
```

---

## Telegram

**Just talk to it.** "why is BTC weak?", "close everything", "size down, the
tape is choppy", "what did you learn this week?" — it uses tools and answers.

Leverage and the symbol universe have no dedicated command on purpose: say
*"go to 20x"* or *"trade only SOL and BTC today"* and the agent applies it
through its `set_leverage` / `update_settings` tools, having first checked the
pair's limits and whether anything is open. `/settings` shows the result.

| Command | |
|---|---|
| `/start` `/help` `/status` | Lifecycle |
| `/balance` `/positions` `/position_history` `/order_history` `/pnl` | Account |
| `/signal` `/scan` `/analyse SYMBOL` | Analysis |
| `/close SYMBOL\|id` `/closeall` | Execution |
| `/auto_trade on\|off` | Master switch for opening new positions. Off still scans, reports and manages what is open. `/pause` `/resume` are aliases |
| `/settings` | All 27 trade settings at a glance |
| `/settings trade\|signals\|risk\|intervals\|agent` | One section, with what each key does and what it accepts |
| `/set <key> <value>` | Change one. `/set <key>` alone explains it instead |
| `/margin_mode …` `/thinking …` | Shortcuts for the common ones |
| `/memory` | What it has learned |
| `/skills` `/skills add\|show\|on\|off\|rm` `/reload` | Teach it new judgement |
| `/model` `/models` | Show the active model per provider, plus anything your key was refused |
| `/models list [prov]` | Every model your key can actually call, best first |
| `/models refresh` | Re-probe (keeps the rejected list) |
| `/models reset` | Re-probe from scratch, forget rejections |
| `/models set <prov> <model>` | Pin a model — it is probed first and refused if unusable |
| `/models set <prov> AUTO` | Back to automatic |

---

## How a trade happens

```
scan universe (every 15s)
   └─ 6 strategies × 3 timeframes per symbol
        └─ weighted consensus       ← regime × live performance × timeframe
             └─ mechanical gates    ← agreement, confidence, cooldown, confirm-scans
                  └─ 🧠 AGENT JUDGEMENT
                       ├─ reads order book, funding, its own history, its memory
                       ├─ may REFUSE a signal that passed every gate
                       └─ returns {take, confidence, margin_usdt, reasoning}
                            └─ market order + dynamic ATR TP/SL attached atomically
                                 └─ guard loop: breakeven → ATR trail
                                      └─ on close: PnL booked, strategy weights
                                         updated, lesson written to memory
```

The mechanical gates decide what *reaches* the agent. The agent decides what
*happens*. It can always say no; it can never say yes to something that failed
a gate.

### Dynamic TP/SL

```
stop   = ATR(14) × k        k = 1.5 − 0.35·strength, ±regime adjustment  → 0.8–3.2
target = stop × R           R = 1.3 + 2.2·strength, ±regime adjustment   → 1.1–4.5
strength = 0.55·(confidence above the gate) + 0.45·(agreement above the gate)
```

A 95%-confidence 5-strategy trend signal gets a tight stop and a ~3.5R target.
A barely-qualified range signal gets a wider stop and ~1.3R. Nothing to
configure, nothing static.

---

## MCP

Works in **both directions**.

### A. Give the agent more tools (MCP client)

Drop an `mcp.json` in the project root and the agent spawns those servers at
boot, discovers their tools, and offers them to the LLM alongside its own 33.

```bash
cp mcp.example.json mcp.json    # then edit
```

```json
{
  "mcpServers": {
    "search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "..." }
    },
    "fetch": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    }
  }
}
```

Now the agent can search the web mid-analysis. Tools are namespaced
`server__tool`, so the above adds `search__brave_web_search` and
`fetch__fetch`. Ask it *"check if there's news on SOL before you size this"*
and it will reach for them on its own.

| Command | |
|---|---|
| `/mcp` | Which servers are up, their tools, and any startup errors |
| `/mcp tools` | Everything callable — built-in and external |
| `/mcp reload` | Re-read `mcp.json` and restart, no process restart needed |

Anything that speaks stdio JSON-RPC works — `npx`, `uvx`, a local script, any
language. `"enabled": false` parks an entry without deleting it.

**A broken server never blocks the trader.** It is logged, skipped, and shown
in red under `/mcp`; everything else carries on. First `npx` boot downloads the
package, so allow a few seconds.

> External tools go to the LLM, which decides when to call them. Only add
> servers you trust.

### B. Let other clients drive this account (MCP server)

### 1. Check the server works

```bash
npm run mcp:test
```

```
✓ initialize — bitunix-ai-trader v1.0.0, protocol 2024-11-05
✓ tools/list — 33 tools (9 marked LIVE)
✓ resources/list — agent://soul, agent://skill, agent://style, agent://memory
✓ prompts/list — analyse, risk_review
✓ tools/call get_ticker — live data returned
✓ unknown tool rejected (-32602)
```

### 2. Generate your config

```bash
npm run mcp:config
```

Prints a paste-ready block with **absolute paths and your real `.env` values**
already filled in, plus where the config file lives on your OS. Nothing to edit.

### 3. Add it to a client

**Claude Desktop** — paste into `claude_desktop_config.json`, then restart:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "bitunix-trader": {
      "command": "node",
      "args": ["/abs/path/bitunix-ai-trader/src/mcp/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "BITUNIX_API_KEY": "...",
        "BITUNIX_API_SECRET": "..."
      }
    }
  }
}
```

**Claude Code** — one command:

```bash
claude mcp add bitunix-trader -- node /abs/path/bitunix-ai-trader/src/mcp/server.js
```

**Cursor** — same JSON in `~/.cursor/mcp.json`, or `.cursor/mcp.json` inside a
project to scope it there.

### Notes

- Use an **absolute** path. MCP clients do not run from your project directory.
- The `env` block is required: clients do not inherit your shell environment, so
  `.env` is not picked up automatically. `npm run mcp:config` fills it for you.
- Without `DATABASE_URL` and the Bitunix keys the read-only market tools still
  work; anything touching the account returns Bitunix `100006`.
- On boot the server runs migrate + seed + load settings, so it shares the same
  Neon state as the Telegram agent — memory and settings stay in sync.
- Unknown tool or resource names come back as JSON-RPC `-32602`, so the client
  can tell a typo from a rejected trade. A real tool that fails returns a
  normal result with `isError: true` and a readable message.

> The 9 LIVE tools move real money from whatever client you connect. Only add
> this to clients you trust.

---

## Personality: soul / skill / style

Three markdown files injected into every system prompt. Edit them to change who
the agent *is* without touching code.

- **`soul/SOUL.md`** — identity, trading philosophy, what it refuses to do
- **`soul/SKILL.md`** — regime taxonomy, the six methods, risk engine, exchange literacy
- **`soul/STYLE.md`** — voice, Telegram formatting discipline, how to report

### Adding your own skills

Drop a `.md` file into **`soul/skills/`** and the agent picks it up on the next
message — no restart, no code change. Optional front matter:

```markdown
---
name: Funding carry
when: funding is above 0.05% per 8h
enabled: true
---

I treat funding as a crowding gauge, not a profit source...
```

`when:` tells the model *when* the knowledge applies, so it is not read as
always-on. `enabled: false` parks a file without deleting it. Files load in
filename order — prefix with `10-`, `20-` to control precedence.

Or do it from Telegram, with no filesystem access:

| Command | Effect |
|---|---|
| `/skills` | List every skill and whether it is on |
| `/skills add <name> \| <text>` | Write a new skill file |
| `/skills show <name>` | Print one |
| `/skills on\|off <name>` | Enable / park it |
| `/skills rm <name>` | Delete it |
| `/reload` | Re-read `soul/` after editing by hand |

Write **judgement**, not facts the agent can fetch with a tool — it already has
33 of those. *"After two losses on the same symbol I halve size until a winner"*
is a skill; *"BTC is near 86,000"* is stale the moment you save it. One idea per
file: the `when:` triggers let the model reach for the right one.

See `soul/skills/README.md` and the disabled `EXAMPLE-funding-carry.md` for a
working template.

---

## Project layout

```
src/
  index.js              boot + wiring
  config.js             env → config, boot validation
  orchestrator.js       5 self-healing loops with backoff
  exchange/
    sign.js             double-SHA256 signature (REST + WS), doc-verified
    bitunix.js          full futures REST surface, 1:1 with the docs
    ws.js               public + private websockets, rate-limited, auto-reconnect
    errors.js           Bitunix error codes → human meaning
  strategies/
    indicators.js       EMA/RMA/RSI/ATR/MACD/BB/KC/ADX/Supertrend/VWAP/StochRSI/regime
    index.js            the six strategies + regime weighting
  scanner/scanner.js    universe building, multi-TF analysis, consensus
  trading/
    risk.js             dynamic TP/SL, ATR trailing, position sizing
    executor.js         live order placement, reversal, TP/SL upsert
    manager.js          position guard, PnL booking, learning loop
  ai/
    providers.js        multi-provider router, AUTO model detection, failover
    agent.js            the reasoning loop, autocompact, signal judgement
    tools.js            33 tools
    soul.js             system-prompt assembly
  telegram/
    bot.js              long-polling client with fail-safe sending
    commands.js         command router + free-form conversation
    format.js           MarkdownV2 escaping (see below)
  db/
    schema.sql          Neon schema
    index.js            data access, degrades gracefully if Neon blips
  mcp/server.js         MCP stdio server
scripts/
  doctor.js             7-step pre-flight
  mcp-config.js         generate an MCP client config
  mcp-test.js           smoke-test the MCP server       pre-flight check
soul/                   SOUL.md · SKILL.md · STYLE.md
  skills/               drop-in .md skills, auto-loaded
```

---

## Notes on the reference projects

This was built from the ground up, but it deliberately fixes the known problems
in the projects it was modelled on:

**The Telegram export bug.** The reference scanner escaped only the
*interpolated values* in its MarkdownV2 templates. Literal `(`, `)`, `.`, `-`,
`/6` and `!` in the templates themselves are also entities, so Telegram
returned `400 can't parse entities` and reports silently vanished. Here:

1. `mdt\`\`` escapes **both** the static text and the interpolations.
2. `agentText()` converts free-form LLM markdown into safe MarkdownV2 —
   stashing code spans, normalising `**bold**`/headings/bullets, escaping
   everything, then restoring only *balanced* emphasis.
3. `sendMessage()` retries as plain text if Telegram still objects, then as
   truncated plain text. A report is never lost.
4. Long messages are split on line boundaries, never truncated.

Verified against a strict reimplementation of Telegram's own entity parser:
every message the agent can produce — signals, fills, positions, settings,
reports, help, raw LLM prose — passes with **0 rejections**.

**Other hardening:** kline pagination (the API caps `limit` at 200, but EMA200
needs more), a global request throttler under the documented 10 req/s, loops
that survive exchange outages with exponential backoff and a single
notification, and DB helpers that degrade to neutral defaults if Neon blips
rather than taking the agent down.

---

## Safety

- Set `TELEGRAM_ALLOWED_CHAT_IDS`. Without it, anyone who finds the bot can trade your account.
- Start with a small `margin_pct` and low `leverage` until you trust it.
- `/pause` stops new entries; the guard keeps protecting what is already open.
- Shutdown (`SIGINT`/`SIGTERM`) does **not** close positions — they stay live on the exchange.
- Use an API key without withdrawal permission, and set an IP whitelist.

---

## License

MIT. Trading futures with leverage can lose you more than you put in. This
software is provided as-is with no warranty. You are responsible for every
order it places.

## Exchange maths (verified against the Bitunix help centre)

**Order units — three different numbers.** Per *Explanation of the Order Units
in Futures Trading* (help centre id=170): "Bitunix offers Nominal Value, Cost
Value, and Quantity Unit as the units for placing orders". They describe the
same position but the amount you type means something different under each:

| unit | the amount is | qty | cost | nominal |
|---|---|---|---|---|
| `NOMINAL` | the position's market value | `nominal / price` | `nominal / leverage` | the amount |
| `COST` | the margin you commit | `cost x leverage / price` | the amount | `cost x leverage` |
| `QTY` | base coin | the amount | `qty x price / leverage` | `qty x price` |

All three reproduce the doc's worked examples (10x, price 10000, amount 1000):
NOMINAL gives qty 0.1 / cost 100, COST gives qty 1 / cost 1000, QTY 1 gives
cost 1000 / nominal 10000.

The same 1000 USDT typed as NOMINAL versus COST is a 10x difference in
position size at 10x leverage, so the units must never be conflated. Note the
REST API has no unit field at all — `POST trade/place_order` documents `qty` as
"Amount (base coin)" and nothing else — so the unit is purely how the caller
thinks, and `bitunix.sizeOrder()` is the single place that converts. It also
reports the cost and nominal implied by the ROUNDED qty, which can differ
materially from the requested figures on a high-priced pair.

**Liquidation price.** Per *Forced Liquidation in Futures Trading* (id=151):

    Long  : liq = entry x (1 - 1/leverage + MMR)
    Short : liq = entry x (1 + 1/leverage - MMR)

Their example (entry 100000, 100x, MMR 0.5%) prints 99505; the closed form
gives 99500, a 0.005% difference that falls on the conservative side. Cross
margin liquidates later than this because the whole balance backs the position,
so applying the isolated formula everywhere under-states the distance to
liquidation — the safe direction.

**Maintenance margin rate.** `GET /api/v1/futures/position/get_position_tiers`
returns the real tier table — `{level, startValue, endValue, leverage,
maintenanceMarginRate}` keyed on position value. Live BTCUSDT:

| tier | notional | max leverage | MMR |
|---|---|---|---|
| L1 | 0 – 100k | 200x | 0.30% |
| L2 | 100k – 400k | 150x | 0.40% |
| L3 | 400k – 1M | 100x | 0.50% |
| L5 | 4M – 10M | 50x | 1.00% |

Both MMR **and the maximum leverage** move with notional, so a large position
loses access to high leverage regardless of the settings; the executor looks
the tier up before ordering and de-levers to it. `mmrFor()` survives only as a
fallback for when the lookup fails — it over-states MMR on every pair measured
(BTC 0.50% guessed against 0.30% real), which is safe but needlessly caps
leverage.

**The stop must live inside liquidation.** ATR stop distance is independent of
leverage; the liquidation price is not. Above a certain leverage they cross and
the stop can never fire. `maxSafeLeverage()` is the largest leverage a given
signal's stop survives with a 25% buffer; the executor de-levers to it, pushes
that leverage to the exchange, and refuses the trade if even the floor will not
fit.

## The four TP/SL methods

Bitunix documents four (help centre id=290). Probing the REST API shows only
two of them exist as endpoints:

| method | what it does | API |
|---|---|---|
| `POSITION` | one trigger closes the whole position | native — `tpsl/position/place_order` |
| `PARTIAL` | scale out in stages, runner left on | native — `tpsl/place_order` with `tpQty` |
| `TRAILING` | arm at an activation price, close on a callback from the best price | **no endpoint** — `tpsl/trailing/*`, `trade/trailing_stop` all 404 |
| `ACCOUNT` | flatten everything on total PnL | **no endpoint** — `tpsl/account/*` 404 |

So trailing and account-level are enforced by this bot's manage loop, not by
the exchange. That distinction is real: a native order fires even if the
process is dead, a software one does not. The trailing engine therefore keeps
writing a native stop underneath as a floor, and the agent is instructed never
to imply the exchange is holding a trailing order it does not have.

`trailingStep()` follows the article's semantics exactly — callback measured
from the best price seen since activation, never from entry, ratcheting only.
It reproduces the doc's worked example (long ETH from 2000, activation 2000,
5% retrace, peak 2500) to the cent: stop 2375.

`partial_tp_ladder` is `share@R` pairs, e.g. `40@1,35@2,25@3`. Shares must sum
to 100 or less and targets must increase; the remainder rides as the runner.
The stop is deliberately never laddered — scaling out of a loser is just being
wrong more slowly.

## Coverage against the official SDK

Checked against github.com/qezawat-a/open-api (Java, Node, Python, Go, PHP).
`FuturesPath.java` lists 33 futures endpoints; all 33 are wrapped in
`src/exchange/bitunix.js`, plus two the Java SDK omits
(`market/get_funding_rate_history`, `cp/asset/query`).

Parameter-level audit against the SDK request classes found four real gaps,
all now closed: `marginCoin` was not sent on the trade endpoints (the SDK
sends it on place_order, cancel_orders, cancel_all_orders,
flash_close_position and the three history/pending queries); the kline
type parameter was named `type` where `KlineRequest` calls it `klineType`
(the endpoint ignores both today, but the name now matches); order status was
never checked after placing; and `PART_FILLED_CANCELED` was unhandled.

That last one matters most. A market order can come back CANCELED (price
protection, thin book, margin recheck) or PART_FILLED_CANCELED — a real
position, but smaller than requested. The executor now reads the order detail
before booking the trade, aborts on a rejection and records the ACTUAL filled
quantity, because carrying the requested size forward would corrupt every
later PnL, stop and trailing calculation.

**There is no demo or testnet.** `ServerConfig.java` defines a single host,
`fapi.bitunix.com`, and the Node, Python and Go config files agree. Bitunix
demo trading exists in the app only — no API host backs it, so nothing here
can be pointed at a paper-trading environment. Every order this bot places is
real, which is why the leverage and liquidation guards matter.

`KlineInterval` carries a second spelling for some intervals (`1min`, `60min`,
`1day`, `1week`, `1month`). All are accepted by the endpoint — including
`3min`, which the enum omits just as it omits `3m` — so they are normalised to
the short form rather than rejected.

## Kline pages drop bars, and it is repairable

Measured across BTC/ETH/SOL/XRP/DOGE/LINK on 5m and 15m:

- a 200-row page requested **without** `endTime` is always complete
- the paged-back request (`endTime = oldest - 1`) came back **exactly one bar
  short, every time, on every symbol**
- re-asking for the same window with `limit=50` returns the missing bar in
  most cases

So the page seam is fine — the bar loss is inside the large `endTime` page
itself, and it is an artefact of page size rather than absent history. This was
not cosmetic: a missing bar shifts every EMA/ATR/ADX period after it, so the
indicators were reading a slightly wrong series on every symbol.

`getCandles` now backfills: after assembling, it re-fetches each hole with a
50-row page and merges what comes back, capped at four repairs per call. On the
sample above that removed 9 of 12 gaps. What survives is genuine missing
history (an exchange outage, those bars never existed) and is reported once per
gap shape rather than on every scan pass.
