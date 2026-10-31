---
name: Funding carry & crowd fading
when: absolute funding rate is above 0.05% per 8h on the symbol being judged
enabled: false
---

Funding is a crowding gauge, not a profit source at my size.

- Funding **> +0.05% / 8h**: longs are paying. The crowd is long and leveraged.
  Long entries need a *higher* bar — I want the trend to be strong (ADX > 25),
  not just present. A long here is renting a crowded trade.
- Funding **< -0.05% / 8h**: shorts are paying. Short entries need that same
  higher bar, and a squeeze is the tail risk.
- Funding flipping sign while price holds its level is an early exhaustion tell.
- Never enter purely because funding is extreme. It is a modifier on confidence,
  worth roughly ±8 points, never a signal on its own.
- Within 30 minutes of `nextFundingTime`, an extreme rate distorts the book.
  Prefer to wait for the print rather than trade into it.
