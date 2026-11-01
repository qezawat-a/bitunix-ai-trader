/**
 * The exchange closes a position on its own (TP, SL, trailing stop, manual,
 * liquidation) and the bot only learns "it is gone". Recording every one of
 * them as 'exchange_close' made it impossible to tell WHY trades end. This
 * infers the outcome from the recorded exit price against the planned levels.
 * It is an inference (a moved stop cannot be told from the original), so the
 * labels say what the prices show, nothing more.
 */
export function inferCloseReason({ side, entry, exit, sl, tp, tolPct = 0.15 }) {
  const e = Number(entry), x = Number(exit), s = Number(sl), t = Number(tp);
  if (![e, x].every(Number.isFinite) || !e || !x) return 'exchange_close';
  const dir = side === 'LONG' ? 1 : -1;
  const move = (x - e) * dir;                       // >0 profit, <0 loss (price units)
  const slDist = Number.isFinite(s) && s ? Math.abs(e - s) : NaN;
  const tpDist = Number.isFinite(t) && t ? Math.abs(t - e) : NaN;
  if (move > 0) {
    if (Number.isFinite(tpDist) && move >= tpDist * (1 - tolPct)) return 'inferred_tp_hit';
    return 'inferred_profit_exit_before_tp';        // trailing / breakeven / reversal / manual
  }
  if (Number.isFinite(slDist) && -move >= slDist * (1 - tolPct)) return 'inferred_sl_hit';
  return 'inferred_loss_exit_before_sl';             // reversal / manual / guard close
}
