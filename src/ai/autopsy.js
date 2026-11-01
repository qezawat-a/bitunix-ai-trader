import { q, settings } from '../db/index.js';
import bitunix from '../exchange/bitunix.js';
import { inferCloseReason } from '../trading/close-reason.js';

/**
 * "Why is it losing?" from the bot's own closed trades (trades table), not from
 * opinion. Everything is computed from recorded entry/exit/planned stop/TP, the
 * close_reason and hold time. summarize() is pure so it can be unit-tested.
 */
const num = (v) => (v == null || v === '' ? NaN : Number(v));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * How far did price go in favour (mfe) and against (mae) of a trade, in % of
 * entry, over its life? From 1m candles; the entry-minute candle also holds a
 * few seconds from before the fill, so values are approximate (about one candle).
 */
export function excursion(candles, { side, entry }) {
  const e = Number(entry);
  if (!e || !candles?.length) return null;
  const hi = Math.max(...candles.map((c) => c.high)), lo = Math.min(...candles.map((c) => c.low));
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return side === 'LONG'
    ? { mfePct: ((hi - e) / e) * 100, maePct: ((e - lo) / e) * 100 }
    : { mfePct: ((e - lo) / e) * 100, maePct: ((hi - e) / e) * 100 };
}

/**
 * Where was the entry inside the two hours before it? chase = 1 means a LONG
 * bought at the top of that range (or a SHORT sold at its bottom): entering after
 * the move already happened. runPct is the move in the trade's direction over the window.
 */
export function entryContext(candles, { side, entry }) {
  const e = Number(entry);
  if (!e || !candles?.length) return null;
  const hi = Math.max(...candles.map((c) => c.high)), lo = Math.min(...candles.map((c) => c.low));
  if (!(hi > lo)) return null;
  const pos = Math.min(1, Math.max(0, (e - lo) / (hi - lo)));
  const dir = side === 'LONG' ? 1 : -1;
  return { chase: side === 'LONG' ? pos : 1 - pos, runPct: ((e - candles[0].open) / candles[0].open) * 100 * dir };
}

export function summarize(rows, opts = {}) {
  const t = rows.map((r) => {
    const entry = num(r.entry_price), exit = num(r.exit_price), sl = num(r.sl_price), tp = num(r.tp_price);
    const dir = r.side === 'LONG' ? 1 : -1;
    const stored = r.close_reason || 'exchange_close';
    return {
      symbol: r.symbol, side: r.side, leverage: num(r.leverage),
      reason: stored === 'exchange_close' ? inferCloseReason({ side: r.side, entry, exit, sl, tp }) : stored,
      notional: num(r.qty) * entry,
      mfe: num(r.mfePct), mae: num(r.maePct), chase: num(r.chase), runPct: num(r.runPct),
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

  // 95% Wilson interval for the win rate: with few trades it is wide, and that is the point.
  const z = 1.96, n = t.length || 1, p = winRate;
  const den = 1 + (z * z) / n;
  const ctr = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  const ci = [Math.max(0, ctr - half), Math.min(1, ctr + half)];
  // Break-even win rate in PRICE terms with the round-trip fee (taker, both legs).
  // ~0.12% is what the position history shows (fee / notional), passed in so it can be changed.
  const feePct = 0.12;
  const wMove = Math.max(0, avg(fin(wins.map((x) => x.movePct)))) - feePct;
  const lMove = Math.abs(avg(fin(losses.map((x) => x.movePct)))) + feePct;
  const beFee = wMove + lMove > 0 && wMove > 0 ? lMove / (wMove + lMove) : NaN;
  const notW = avg(fin(wins.map((x) => x.notional))), notL = avg(fin(losses.map((x) => x.notional)));
  const byLev = {};
  for (const x of t) { const k = Number.isFinite(x.leverage) ? `${x.leverage}x` : '?'; const b = (byLev[k] ||= { n: 0, wins: 0, pnl: 0 }); b.n += 1; b.wins += x.pnl > 0 ? 1 : 0; b.pnl += x.pnl; }
  const leverages = Object.entries(byLev).map(([lev, b]) => ({ lev, ...b })).sort((a, b) => a.pnl - b.pnl);

  const slHits = t.filter((x) => x.reason === 'inferred_sl_hit' && Number.isFinite(x.mfe));
  const reachedHalf = slHits.filter((x) => Number.isFinite(x.tpPct) && x.mfe >= x.tpPct * 0.5).length;
  const neverWorked = slHits.filter((x) => x.mfe < 0.15).length;
  const medMfeSl = median(slHits.map((x) => x.mfe));

  // Breakeven arms at a LEVERAGED ROI %, so the price move it needs is roi / leverage.
  const beRoi = Number(opts.breakevenRoi);
  const armOf = (x) => (Number.isFinite(beRoi) && x.leverage > 0 ? beRoi / x.leverage : NaN);
  const armed = slHits.filter((x) => Number.isFinite(armOf(x)) && x.mfe >= armOf(x)).length;
  const notArmed = slHits.filter((x) => Number.isFinite(armOf(x)) && x.mfe < armOf(x)).length;
  const bestMoveBuckets = [0.2, 0.3, 0.4].map((v) => ({ atLeastPct: v, stopOuts: slHits.filter((x) => x.mfe >= v).length }));

  const withCtx = t.filter((x) => Number.isFinite(x.chase));
  const chasing = withCtx.filter((x) => x.chase >= 0.85).length;
  const longs = t.filter((x) => x.side === 'LONG').length;
  const ctx = withCtx.length ? {
    n: withCtx.length, chasing, medianChaseWins: median(withCtx.filter((x) => x.pnl > 0).map((x) => x.chase)),
    medianChaseLosses: median(withCtx.filter((x) => x.pnl <= 0).map((x) => x.chase)),
    medianRunPct: median(withCtx.map((x) => x.runPct)),
  } : null;

  const findings = [];
  if (t.length < 20) findings.push(`Only ${t.length} closed trades: treat every conclusion below as a lead, not proof.`);
  if (Number.isFinite(beFee)) findings.push(`In price terms (avg win ${(wMove + feePct).toFixed(2)}% / avg loss ${(lMove - feePct).toFixed(2)}%, minus ~${feePct}% round-trip fees) break-even needs a ${(beFee * 100).toFixed(0)}% win rate. Actual ${(winRate * 100).toFixed(0)}% (95% range ${(ci[0] * 100).toFixed(0)}-${(ci[1] * 100).toFixed(0)}%)${ci[1] < beFee ? ': clearly below break-even.' : ci[0] > beFee ? ': above break-even.' : ': break-even is inside that range, too few trades to call it.'}`);
  if (notW > 0 && notL > 0 && notL > notW * 1.5) findings.push(`Losing trades were bigger: avg notional ${notL.toFixed(2)} USDT on losers vs ${notW.toFixed(2)} on winners, which is why USDT losses outweigh USDT wins even though price moves favour the wins.`);
  if (medTp > 0 && avgWinMove > 0 && avgWinMove < medTp * 0.6) findings.push(`Winners are cut early: they capture ${avgWinMove.toFixed(2)}% of price on average vs a planned TP distance of ${medTp.toFixed(2)}% (${(avgWinMove / medTp * 100).toFixed(0)}%). Look at the close_reason rows below for what closes them.`);
  if (slHits.length >= 3) findings.push(`Of ${slHits.length} stop-outs: ${reachedHalf} first went at least half-way to the target (stop/trailing too slow or too tight), ${neverWorked} never got more than 0.15% in favour (entry timing/direction wrong from the first minute). Median best move before the stop: ${medMfeSl.toFixed(2)}%.`);
  if (Number.isFinite(beRoi) && medTp > 0) {
    const lv = [10, 20, 40].map((l) => `${l}x: ${(beRoi / l).toFixed(2)}%`).join(', ');
    findings.push(`Breakeven arms at ${beRoi}% ROI = price move of ${lv}; the median planned TP is only ${medTp.toFixed(2)}%. Where the arming distance is at or beyond the TP, breakeven can never protect a trade before the TP/stop decides it.`);
    if (slHits.length >= 3) findings.push(`Of ${slHits.length} stop-outs: ${armed} reached their breakeven arming level and still lost (the stop should have moved: check /diagnose), ${notArmed} never reached it.`);
  }
  if (t.length >= 5 && (longs === 0 || longs === t.length || longs / t.length >= 0.85 || longs / t.length <= 0.15)) findings.push(`Direction is lopsided: ${longs} LONG / ${t.length - longs} SHORT.`);
  if (ctx && ctx.n >= 5 && ctx.chasing / ctx.n >= 0.5) findings.push(`Entries chase the move: ${ctx.chasing} of ${ctx.n} were at the extreme 15% of the previous 2 hours' range (a long at the top / a short at the bottom); the price had already moved ${ctx.medianRunPct.toFixed(1)}% in the trade's direction (median).`);
  else if (ctx && ctx.n >= 5) findings.push(`Entries are not chasing: only ${ctx.chasing} of ${ctx.n} were in the extreme 15% of the previous 2 hours' range.`);
  if (medSl > 0 && medSl < 0.5) findings.push(`Stops are tight: median planned stop is ${medSl.toFixed(2)}% of price, inside normal 1m-5m noise.`);
  if (losses.length && quickLosses / losses.length >= 0.5) findings.push(`${quickLosses} of ${losses.length} losses closed within 5 minutes: entries are being stopped by noise right after opening.`);
  if (lossHold && winHold && winHold < lossHold * 0.5) findings.push(`Winners are held ${winHold.toFixed(0)} min vs losers ${lossHold.toFixed(0)} min: profits are taken fast, losses are allowed to run.`);
  const worst = reasons[0];
  if (worst && worst.pnl < 0) findings.push(`Biggest loss bucket: close_reason "${worst.reason}" - ${worst.n} trades, PnL ${worst.pnl.toFixed(4)}.`);

  return {
    trades: t.length, wins: wins.length, losses: losses.length, pnl: t.reduce((a, x) => a + x.pnl, 0),
    winRate, avgWin, avgLoss, breakEvenWinRate, medianPlannedSlPct: medSl, medianPlannedTpPct: medTp,
    avgWinMovePct: avgWinMove, avgLossMovePct: avgLossMove, avgHoldWinMin: winHold, avgHoldLossMin: lossHold,
    breakEvenWinRatePriceFee: beFee, winRateCI: ci, avgNotionalWin: notW, avgNotionalLoss: notL, leverages,
    stopOuts: { n: slHits.length, reachedHalfTarget: reachedHalf, neverWorked, medianBestMovePct: medMfeSl, armedButLost: armed, neverArmed: notArmed, bestMoveBuckets },
    longs, shorts: t.length - longs, entryContext: ctx,
    reasons, findings,
  };
}

export async function autopsy({ days = 7, excursions = true } = {}) {
  const d = Math.max(0.02, Math.min(90, Number(days) || 7));
  const { rows } = await q(
    `SELECT symbol, side, leverage, qty, entry_price, exit_price, sl_price, tp_price, realized_pnl, close_reason, opened_at, closed_at
     FROM trades WHERE status='CLOSED' AND closed_at > now() - ($1||' days')::interval ORDER BY closed_at DESC LIMIT 500`, [String(d)]);
  let note = null;
  if (excursions) {
    // Only the stop-outs need it, newest 20: that is where "noise or wrong entry?" is decided.
    let done = 0;
    for (const r of rows) {
      if (done >= 20) break;
      if (inferCloseReason({ side: r.side, entry: r.entry_price, exit: r.exit_price, sl: r.sl_price, tp: r.tp_price }) !== 'inferred_sl_hit'
        && r.close_reason !== 'inferred_sl_hit') continue;
      try {
        const start = Math.floor(new Date(r.opened_at).getTime() / 60000) * 60000;
        const raw = await bitunix.getKline({ symbol: r.symbol, interval: '1m', startTime: start, endTime: new Date(r.closed_at).getTime(), limit: 200 });
        const candles = (raw || []).map((k) => ({ high: Number(k.high), low: Number(k.low) })).filter((c) => c.high > 0 && c.low > 0);
        const ex = excursion(candles, { side: r.side, entry: Number(r.entry_price) });
        if (ex) { r.mfePct = ex.mfePct; r.maePct = ex.maePct; done += 1; }
      } catch (e) { note = `candles unavailable for some trades: ${e.message}`; }
    }
  }
  if (excursions) {
    let n = 0;
    for (const r of rows) {
      if (n >= 25) break;
      try {
        const end = new Date(r.opened_at).getTime();
        const raw = await bitunix.getKline({ symbol: r.symbol, interval: '5m', startTime: end - 2 * 3600_000, endTime: end, limit: 24 });
        const candles = (raw || []).map((k) => ({ open: Number(k.open), high: Number(k.high), low: Number(k.low) })).filter((c) => c.high > 0 && c.low > 0 && c.open > 0);
        const cx = entryContext(candles, { side: r.side, entry: Number(r.entry_price) });
        if (cx) { r.chase = cx.chase; r.runPct = cx.runPct; n += 1; }
      } catch (e) { note = note || `candles unavailable for some trades: ${e.message}`; }
    }
  }
  return { days: d, note, breakevenRoi: Number(settings().breakeven_threshold), ...summarize(rows, { breakevenRoi: Number(settings().breakeven_threshold) }) };
}
