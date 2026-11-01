import { q } from '../db/index.js';

/**
 * "Why is it losing?" from the bot's own closed trades (trades table), not from
 * opinion. Everything is computed from recorded entry/exit/planned stop/TP, the
 * close_reason and hold time. summarize() is pure so it can be unit-tested.
 */
const num = (v) => (v == null || v === '' ? NaN : Number(v));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function summarize(rows) {
  const t = rows.map((r) => {
    const entry = num(r.entry_price), exit = num(r.exit_price), sl = num(r.sl_price), tp = num(r.tp_price);
    const dir = r.side === 'LONG' ? 1 : -1;
    return {
      symbol: r.symbol, side: r.side, leverage: num(r.leverage), reason: r.close_reason || 'unknown',
      pnl: num(r.realized_pnl),
      movePct: entry && exit ? ((exit - entry) / entry) * 100 * dir : NaN,
      slPct: entry && sl ? (Math.abs(entry - sl) / entry) * 100 : NaN,
      tpPct: entry && tp ? (Math.abs(tp - entry) / entry) * 100 : NaN,
      holdMin: r.closed_at && r.opened_at ? (new Date(r.closed_at) - new Date(r.opened_at)) / 60000 : NaN,
    };
  }).filter((x) => Number.isFinite(x.pnl));

  const wins = t.filter((x) => x.pnl > 0), losses = t.filter((x) => x.pnl <= 0);
  const avgWin = avg(wins.map((x) => x.pnl)), avgLoss = Math.abs(avg(losses.map((x) => x.pnl)));
  const winRate = t.length ? wins.length / t.length : 0;
  const breakEvenWinRate = avgWin + avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0;

  const byReason = {};
  for (const x of t) {
    const r = (byReason[x.reason] ||= { n: 0, wins: 0, pnl: 0, moves: [] });
    r.n += 1; r.wins += x.pnl > 0 ? 1 : 0; r.pnl += x.pnl; if (Number.isFinite(x.movePct)) r.moves.push(x.movePct);
  }
  const reasons = Object.entries(byReason)
    .map(([reason, r]) => ({ reason, n: r.n, wins: r.wins, pnl: r.pnl, avgMovePct: avg(r.moves) }))
    .sort((a, b) => a.pnl - b.pnl);

  const fin = (a) => a.filter(Number.isFinite);
  const medSl = median(fin(t.map((x) => x.slPct))), medTp = median(fin(t.map((x) => x.tpPct)));
  const avgWinMove = avg(fin(wins.map((x) => x.movePct))), avgLossMove = avg(fin(losses.map((x) => x.movePct)));
  const winHold = avg(fin(wins.map((x) => x.holdMin))), lossHold = avg(fin(losses.map((x) => x.holdMin)));
  const quickLosses = losses.filter((x) => Number.isFinite(x.holdMin) && x.holdMin <= 5).length;

  const findings = [];
  if (t.length < 20) findings.push(`Only ${t.length} closed trades: treat every conclusion below as a lead, not proof.`);
  if (winRate < breakEvenWinRate - 0.1) findings.push(`Payoff problem: avg win ${avgWin.toFixed(4)} vs avg loss ${avgLoss.toFixed(4)} needs a ${(breakEvenWinRate * 100).toFixed(0)}% win rate to break even; actual is ${(winRate * 100).toFixed(0)}%.`);
  if (medTp > 0 && avgWinMove > 0 && avgWinMove < medTp * 0.6) findings.push(`Winners are cut early: they capture ${avgWinMove.toFixed(2)}% of price on average vs a planned TP distance of ${medTp.toFixed(2)}% (${(avgWinMove / medTp * 100).toFixed(0)}%). Look at the close_reason rows below for what closes them.`);
  if (medSl > 0 && medSl < 0.5) findings.push(`Stops are tight: median planned stop is ${medSl.toFixed(2)}% of price, inside normal 1m-5m noise.`);
  if (losses.length && quickLosses / losses.length >= 0.5) findings.push(`${quickLosses} of ${losses.length} losses closed within 5 minutes: entries are being stopped by noise right after opening.`);
  if (lossHold && winHold && winHold < lossHold * 0.5) findings.push(`Winners are held ${winHold.toFixed(0)} min vs losers ${lossHold.toFixed(0)} min: profits are taken fast, losses are allowed to run.`);
  const worst = reasons[0];
  if (worst && worst.pnl < 0) findings.push(`Biggest loss bucket: close_reason "${worst.reason}" - ${worst.n} trades, PnL ${worst.pnl.toFixed(4)}.`);

  return {
    trades: t.length, wins: wins.length, losses: losses.length, pnl: t.reduce((a, x) => a + x.pnl, 0),
    winRate, avgWin, avgLoss, breakEvenWinRate, medianPlannedSlPct: medSl, medianPlannedTpPct: medTp,
    avgWinMovePct: avgWinMove, avgLossMovePct: avgLossMove, avgHoldWinMin: winHold, avgHoldLossMin: lossHold,
    reasons, findings,
  };
}

export async function autopsy({ days = 7 } = {}) {
  const d = Math.max(1, Math.min(90, Number(days) || 7));
  const { rows } = await q(
    `SELECT symbol, side, leverage, entry_price, exit_price, sl_price, tp_price, realized_pnl, close_reason, opened_at, closed_at
     FROM trades WHERE status='CLOSED' AND closed_at > now() - ($1||' days')::interval ORDER BY closed_at DESC LIMIT 500`, [String(d)]);
  return { days: d, ...summarize(rows) };
}
