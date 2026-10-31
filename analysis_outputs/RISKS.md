# Suspicious Patterns

Heuristics only; not confirmed bugs.

## From the automated heuristic pass

- `src/index.js`: LIVE-only mode with no dry-run/paper trading; real orders may be placed during any test or manual run.
- `src/index.js`: process exits on unhandled rejection only via logging; verify error recovery paths.
- `bitunix-mcp/`: nested separate git repo is untracked at top level; ensure it is not accidentally committed or ignored inconsistently.
- `node_modules/` and `bitunix-mcp/node_modules/` are present; keep them out of analysis and commits.
- No CI configuration detected at repo root (only nested `bitunix-mcp/.github/workflows/ci.yml`).
- Tests run via `node tests/run.js`; inspect for side effects before running in a live environment.

## From manual read-only review (executor.js / orchestrator.js / risk.js)

- **Stop ratchet is in-memory only** (`src/trading/executor.js` → `bestStop = new Map()`). On restart the ratchet is empty, so the first `upsertPositionTpSl` call after a restart has no `prev` and can loosen a stop that the previous process had already tightened. `verifyStopApplied` prevents silent writes, but the loosening itself is not blocked across a restart.
- ~~**`ensureSymbolConfig` caches the requested leverage, not the applied tier-capped leverage**~~ — RESOLVED. The cache now stores the leverage read back from the exchange after a successful write (or the exchange's own value when it already matched), and it is written only after the write succeeded. `ensureSymbolConfig` returns that verified value and `openFromSignal` sizes off it, so a tier clamp can no longer desynchronise the cache from exchange state, nor size a position against a leverage the position does not have. This was also what made `changeLeverage` fire on nearly every entry.
- **Reversal gap** (`src/trading/executor.js` → `reverse`). Between `closePosition` and `openFromSignal` there is a 1.2 s sleep plus openFromSignal latency, with no position held on either side. In a fast move the opposite entry may fill far from the signal price.
- **Five self-rescheduling loops with no global tick mutex** (`src/orchestrator.js`). Each loop guards its own `inFlight` set, but two loops reading the same position state concurrently (e.g. manage + scan on a symbol mid-reversal) is only safe if the exchange is the source of truth.
- **Dual config surface**: `.env` seeds boot values; Neon `agent_settings` is the runtime source of truth. A new setting added to `settings-schema.js` needs a seed in `seedSettings()` and a DB column in `schema.sql` — three touch points that are easy to miss.
- ~~**Tier-based leverage capping is advisory**~~ — CHANGED BY OPERATOR REQUEST. The old de-lever block cut leverage to the position-tier cap and again to `maxSafeLeverage` whenever the ATR stop did not fit the liquidation buffer, on every entry. Cutting leverage shrinks the position, so a trade the scanner qualified arrived at a fraction of its intended size — a loss, not a safety improvement. That block is gone: `computeDynamicTpSl` clamps the stop inside liquidation instead, so the position keeps its full size and the stop moves to where it can actually fire. The only remaining refusal is a liquidation price at/through the entry. **Operator note:** with `leverage` set high on a thin pair the stop will now be pulled in tight rather than the position being scaled down — lower `/set leverage` if that is not wanted.
- **Closed-position PnL sign is now settled, not assumed** (`src/trading/manager.js`). `get_history_positions` documents `realizedPNL` as *"Realized PnL(exclude funding fee and transaction fee)"*, `fee` as deducted (positive = cost) and `funding` as negative = paid. So the true result is `realizedPNL - fee + funding`. The booking path already used that; `exchangePerformance` had `net: pnl + fees + funding`, which added the fee back and overstated `/pnl` by twice the commission. Both paths now agree.
