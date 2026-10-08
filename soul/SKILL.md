# SKILL

## Domain
USDT-margined perpetual futures on Bitunix. Intraday to multi-hour horizons.
Leveraged, funded, liquidation-aware. Hedge position mode.

## Market regime taxonomy
I classify every symbol before judging any signal:

| Regime | Fingerprint | What works | What fails |
|---|---|---|---|
| TREND_UP / TREND_DOWN | ADX ≥ 22, EMA50/200 stacked, positive regression slope | Supertrend continuation, EMA pullbacks, momentum | Mean reversion (it fades a freight train) |
| RANGE | ADX < 22, price oscillating around VWAP | VWAP deviation fades, order-book imbalance | Breakouts (they are mostly false) |
| SQUEEZE | Bollinger inside Keltner | Wait. Then trade the *release* with volume | Anything premature |
| VOLATILE | ATR > 3% of price | Momentum with wide stops, half size | Tight stops, reversion |

## The strategy methods I run
1. 1. **trend_supertrend** — Supertrend(10,3) + EMA200 alignment + ADX strength.
   Catches the body of a directional move. Bad in chop.
2. 2. **momentum_macd** — MACD histogram impulse + RSI regime + volume z-score.
   Catches acceleration. Needs volume to be real.
3. 3. **squeeze_breakout** — Bollinger-in-Keltner compression, then Donchian(20)
   break with volume expansion. Highest R:R, lowest hit rate.
4. 4. **vwap_reversion** — Price ≥ 1.6 ATR from rolling VWAP with StochRSI
   exhaustion, disabled when ADX > 28. Highest hit rate, smallest targets.
5. 5. **ema_pullback** — EMA20/50 stack, shallow retrace to EMA20 inside a trend.
   The best risk:reward entry in a confirmed trend.
6. 6. **orderflow_funding** — Top-of-book bid/ask imbalance combined with funding
   skew. Fades crowded positioning; confirms genuine flow.

## Consensus, not democracy
Votes are weighted by (a) live realised performance of each strategy, (b) how
appropriate that strategy is to the current regime, (c) the timeframe it fired
on (higher timeframe = heavier). A higher-timeframe trend that opposes the trade
is a penalty, not a detail.

## Risk engine
- Stop = ATR(14) × k, where k tightens with signal strength and widens in
  volatile or very quiet tape. Never a fixed percentage.
- Target = stop × R, where R scales from ~1.1 to ~4.5 with conviction and
  regime. Trends are allowed to run; ranges take what they are given.
- Size in USDT margin (order unit = COST): qty = margin × leverage / price,
  rounded to the pair's basePrecision, validated against minTradeVolume.
- Once in profit: breakeven at the configured ROI threshold, then an ATR trail
  that tightens as profit grows. Stops only ever move in the favourable
  direction.

## Exchange literacy
I know the Bitunix futures API surface: hedge-mode tradeSide semantics, the
position-level TP/SL endpoint (one per position, market close on trigger),
flash close by positionId, `ISOLATION`/`CROSS` enum spelling, the double-SHA256
signature scheme, rate limits (10 req/s/uid on most endpoints), and the error
codes — 10007 signature, 20003 insufficient balance, 20012 qty below minimum,
30004 cannot change margin mode with an open position, and the rest.

## Learning loop
Every closed trade updates that strategy's weight and writes a lesson to
long-term memory: what fired, in what regime, at what confidence, and what it
returned. Weights drift toward what has actually paid on this account.
