---
name: Bitunix trading analysis pipeline
when: the user asks for a full trading analysis on a Bitunix futures symbol (e.g. BTCUSDT, ETHUSDT)
enabled: true
---

I run a 5-phase trading analysis pipeline on Bitunix USDT-M perpetual futures, using only the exchange's official REST endpoints.

Phase 1 (four analysts in parallel):
- Technical analyst — 1h kline data from GET /futures/market/kline, order book from GET /futures/market/depth, tickers from GET /futures/market/tickers. Reports trend (price vs EMA10/SMA50/SMA200), momentum (RSI, MACD), volatility (ATR %, Bollinger position), and key support/resistance levels. Ends with TECHNICAL SIGNAL: BULLISH / BEARISH / NEUTRAL.
- News & sentiment analyst — funding rate from GET /futures/market/funding_rate, funding history from GET /futures/market/funding_rate/history, position tiers from GET /futures/position/get_position_tiers. Funding extremes are the crowded-positioning proxy for crypto futures. Ends with SENTIMENT SIGNAL: POSITIVE / NEGATIVE / NEUTRAL.
- Fundamentals analyst — crypto futures have no P/E or balance sheet. Substitutes: 24h volume (liquidity), funding rate (cost of carry), max leverage from position tiers, pair specs from GET /futures/market/trading_pairs. Ends with FUNDAMENTAL SIGNAL: STRONG / FAIR / WEAK.
- Macro analyst — BTCUSDT and ETHUSDT 24h change as the broad-market proxy. Classifies RISK-ON / RISK-OFF / NEUTRAL.

Phase 2 (sequential debate):
- Bull analyst builds the long case using specific data from Phase 1. Ends with BULL CONVICTION: HIGH / MEDIUM / LOW.
- Bear analyst rebuts the bull's specific claims. Ends with BEAR CONVICTION: HIGH / MEDIUM / LOW.
- Risk analyst stress-tests leverage, liquidation distance, ATR %, funding crowding, and macro tail risks. Ends with RISK LEVEL: HIGH / MEDIUM / LOW.

Phase 3 — Research Manager evaluates the debate and issues RECOMMENDATION: Buy / Overweight / Hold / Underweight / Sell, with rationale and strategic actions.

Phase 4 — Trader converts the plan into a concrete proposal: ACTION, REASONING, ENTRY price, STOP price, SIZE — all anchored to ATR-based levels from the technical report.

Phase 5 — Portfolio Manager synthesizes everything into the final decision: TICKER, DATE, SIGNAL (BUY / SELL / HOLD), RATING, ENTRY, STOP, SIZE, plus one-sentence bull/bear summaries and a verdict.

Every number is fetched live from Bitunix — nothing is invented. If an endpoint is unreachable I say so rather than guessing.
