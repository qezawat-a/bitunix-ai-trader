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

/** Candles, oldest first, from whatever shape the endpoint answered. */
export function bars(raw) {
  return (raw || [])
    .map((k) => ({
      time: Number(k?.time ?? k?.ts ?? 0),
      open: Number(k?.open), high: Number(k?.high), low: Number(k?.low), close: Number(k?.close),
    }))
    .filter((c) => c.high > 0 && c.low > 0)
    .sort((a, b) => a.time - b.time);
}

/**
 * The candles a trade ACTUALLY lived through.
 *
 * get_kline ignores `startTime`: with limit=L it always answers the last L bars
 * ending at `endTime`. Measured against the live endpoint (2026-11-03, 1m,
 * limit 200): asking for the window 16:53..16:57 returned 200 bars running from
 * 13:37 to 16:56 — over three hours BEFORE the trade. That single fact produced
 * the two headline findings of every autopsy ("13 of 14 stop-outs went past
 * their planned TP", "all of them reached the breakeven level and still lost"):
 * the max high of that window belonged to price action from before the position
 * existed. So the window is paged backwards until it reaches the entry and then
 * FILTERED to [from, to] — the trade's own life, nothing else.
 *
 * `fetchKline` is injectable so this is unit-testable without the network.
 */
export async function tradeCandles({
  symbol, from, to, interval = '1m', type = 'MARK_PRICE',
  page = 200, maxPages = 6, fetchKline = null,
}) {
  const start = Number(from), end = Number(to);
  if (!(end > 0) || !(start > 0) || end < start) return [];
  const get = fetchKline || ((q) => bitunix.getKline(q));
  let all = bars(await get({ symbol, interval, endTime: end, limit: page, type }));
  for (let i = 0; i < maxPages; i++) {
    const oldest = all[0]?.time;
    if (!oldest || oldest <= start) break;
    const older = bars(await get({ symbol, interval, endTime: oldest - 1, limit: page, type }));
    if (!older.length) break;
    all = older.concat(all);
  }
  return all.filter((c) => c.time >= start && c.time <= end);
}

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
  const mk = (h, l) => (side === 'LONG'
    ? { mfe: ((h - e) / e) * 100, mae: ((e - l) / e) * 100 }
    : { mfe: ((e - l) / e) * 100, mae: ((h - e) / e) * 100 });
  const all = mk(hi, lo);
  // Lower bound: drop the entry-minute candle, which also holds pre-fill prices.
  const rest = candles.slice(1);
  const lower = rest.length ? mk(Math.max(...rest.map((c) => c.high)), Math.min(...rest.map((c) => c.low))) : null;
  return { mfePct: all.mfe, maePct: all.mae, mfeAfterEntryPct: lower ? lower.mfe : null };
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
      mfe: num(r.mfePct), mae: num(r.maePct), mfeLo: num(r.mfeAfterEntryPct), chase: num(r.chase), runPct: num(r.runPct),
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

  // Stop-outs, and how many of them we could actually MEASURE. The excursion
  // comes from 1m mark candles covering the trade's own life; when the endpoint
  // returns no usable window for a trade, saying nothing is the honest answer —
  // an earlier version compared whatever candles came back and produced
  // "13 of 14 went past their TP" out of price action from hours before the
  // trade existed.
  const stopOuts = t.filter((x) => x.reason === 'inferred_sl_hit');
  const slHits = stopOuts.filter((x) => Number.isFinite(x.mfe));
  const coverage = stopOuts.length ? slHits.length / stopOuts.length : 0;
  const measured = slHits.length >= 3 && coverage >= 0.6;
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

  const beyondTpHi = slHits.filter((x) => Number.isFinite(x.tpPct) && x.mfe >= x.tpPct).length;
  const beyondTpLo = slHits.filter((x) => Number.isFinite(x.tpPct) && Number.isFinite(x.mfeLo) && x.mfeLo >= x.tpPct).length;

  /**
   * Where did the LOSING trades actually close, compared with their OWN planned
   * stop? No candles needed — entry, exit and the stop recorded when the trade
   * opened are all in the row.
   *
   * This is the question that matters after a loss ("why -0.08% when the stop
   * was -0.71%?"): an exit at the stop means the plan worked, an exit far
   * SHALLOWER means something other than the stop closed it (or the exchange
   * held a tighter stop than the one written down), and an exit far BEYOND it
   * means the stop fired late or slipped through the trigger.
   */
  const losing = t.filter((x) => x.pnl <= 0 && Number.isFinite(x.slPct) && x.slPct > 0 && Number.isFinite(x.movePct));
  const adverseOf = (x) => -x.movePct;            // movePct is direction-aware, so a loss is negative
  const atStop = losing.filter((x) => adverseOf(x) >= x.slPct * 0.85 && adverseOf(x) <= x.slPct * 1.15);
  const shortOfStop = losing.filter((x) => adverseOf(x) < x.slPct * 0.85);
  const beyondStop = losing.filter((x) => adverseOf(x) > x.slPct * 1.15);
  const exitVsStop = {
    n: losing.length,
    atStop: atStop.length, shortOfStop: shortOfStop.length, beyondStop: beyondStop.length,
    medianShortPct: median(shortOfStop.map(adverseOf)),
    medianShortStopPct: median(shortOfStop.map((x) => x.slPct)),
    medianBeyondPct: median(beyondStop.map(adverseOf)),
    medianBeyondStopPct: median(beyondStop.map((x) => x.slPct)),
  };
  // Losses closed inside the fee band: the trade barely moved, so the round trip
  // (two taker legs ~0.12%) is the whole result. These are winners/scratches the
  // account paid for, not market losses.
  const flatLosses = t.filter((x) => x.pnl < 0 && Number.isFinite(x.movePct) && Math.abs(x.movePct) < 0.15);

  const findings = [];
  if (t.length < 20) findings.push(`Only ${t.length} closed trades: treat every conclusion below as a lead, not proof.`);
  if (Number.isFinite(beFee)) findings.push(`In price terms (avg win ${(wMove + feePct).toFixed(2)}% / avg loss ${(lMove - feePct).toFixed(2)}%, minus ~${feePct}% round-trip fees) break-even needs a ${(beFee * 100).toFixed(0)}% win rate. Actual ${(winRate * 100).toFixed(0)}% (95% range ${(ci[0] * 100).toFixed(0)}-${(ci[1] * 100).toFixed(0)}%)${ci[1] < beFee ? ': clearly below break-even.' : ci[0] > beFee ? ': above break-even.' : ': break-even is inside that range, too few trades to call it.'}`);
  if (notW > 0 && notL > 0 && notL > notW * 1.5) findings.push(`Losing trades were bigger: avg notional ${notL.toFixed(2)} USDT on losers vs ${notW.toFixed(2)} on winners, which is why USDT losses outweigh USDT wins even though price moves favour the wins.`);
  if (medTp > 0 && avgWinMove > 0 && avgWinMove < medTp * 0.6) findings.push(`Winners are cut early: they capture ${avgWinMove.toFixed(2)}% of price on average vs a planned TP distance of ${medTp.toFixed(2)}% (${(avgWinMove / medTp * 100).toFixed(0)}%). Look at the close_reason rows below for what closes them.`);
  if (measured) findings.push(`Of ${slHits.length} stop-outs with candle data: ${reachedHalf} went at least half-way to the planned target at some point, ${neverWorked} never got more than 0.15% in favour. Median best move before the stop: ${medMfeSl.toFixed(2)}% (1m mark series, inside the trade's own life). This is the ceiling of what price OFFERED between polls - a wick can be gone before the guard's next pass, so it is not proof the stop could have moved.`);
  else if (stopOuts.length >= 3) findings.push(`${stopOuts.length} stop-outs, but only ${slHits.length} had usable candles for their own life: the "how far did it go in favour" measures are left out rather than guessed from the wrong hours.`);
  if (Number.isFinite(beRoi) && medTp > 0) {
    const lv = [10, 20, 40].map((l) => `${l}x: ${(beRoi / l).toFixed(2)}%`).join(', ');
    findings.push(`Breakeven arms at ${beRoi}% ROI = price move of ${lv}; the median planned TP is only ${medTp.toFixed(2)}%. Where the arming distance is at or beyond the TP, breakeven can never protect a trade before the TP/stop decides it.`);
    if (measured) findings.push(`Of ${slHits.length} stop-outs: ${armed} touched their breakeven arming level at some point on the 1m series, ${notArmed} never did. Touching a level between two guard passes is not the same as being tradeable: a wick can appear and vanish in seconds, so this does not by itself mean the stop should have moved.`);
  }
  if (t.length >= 5 && (longs === 0 || longs === t.length || longs / t.length >= 0.85 || longs / t.length <= 0.15)) findings.push(`Direction is lopsided: ${longs} LONG / ${t.length - longs} SHORT.`);
  if (ctx && ctx.n >= 5 && ctx.chasing / ctx.n >= 0.5) findings.push(`Entries chase the move: ${ctx.chasing} of ${ctx.n} were at the extreme 15% of the previous 2 hours' range (a long at the top / a short at the bottom); the price had already moved ${ctx.medianRunPct.toFixed(1)}% in the trade's direction (median).`);
  else if (ctx && ctx.n >= 5) findings.push(`Entries are not chasing: only ${ctx.chasing} of ${ctx.n} were in the extreme 15% of the previous 2 hours' range.`);
  if (measured && beyondTpHi > 0) findings.push(`${beyondTpHi} of ${slHits.length} stop-outs went PAST their planned TP distance at some point (${beyondTpLo} even excluding the entry minute). Careful: the planned TP is the single target recorded at entry - a ladder (partial TPs) puts the real exits elsewhere - and this is the max of the 1m mark series, so it says what PRICE did, not which orders the exchange held. Treat it as a reason to look (/tpsl SYMBOL), not as proof a target was missing.`);
  if (medSl > 0 && medSl < 0.5) findings.push(`Stops are tight: median planned stop is ${medSl.toFixed(2)}% of price, inside normal 1m-5m noise.`);
  if (losses.length && quickLosses / losses.length >= 0.5) findings.push(`${quickLosses} of ${losses.length} losses closed within 5 minutes: entries are being stopped by noise right after opening.`);
  if (flatLosses.length >= 2 && flatLosses.length / losses.length >= 0.2) {
    findings.push(`${flatLosses.length} of ${losses.length} losses closed within 0.15% of their entry: the trade barely moved, so the ~0.12% round trip (two taker legs) is the whole result. Those are scratches that cost commission — a "breakeven" exit parked at +0.08% is a loss for exactly this reason (fixed: the floor now covers both legs).`);
  }
  if (exitVsStop.n >= 3) {
    if (exitVsStop.shortOfStop / exitVsStop.n >= 0.3) {
      findings.push(`${exitVsStop.shortOfStop} of ${exitVsStop.n} losing trades closed SHALLOWER than their own planned stop (median move ${exitVsStop.medianShortPct.toFixed(2)}% against a stop at ${exitVsStop.medianShortStopPct.toFixed(2)}%): the stop did not close them. Something else did — a software stop, an agent/manual close, an account-level flatten — or the stop the exchange held was tighter than the one recorded at entry. Compare orders, not prices: /diagnose SYMBOL on a fresh loss.`);
    }
    if (exitVsStop.beyondStop / exitVsStop.n >= 0.3) {
      findings.push(`${exitVsStop.beyondStop} of ${exitVsStop.n} losing trades closed BEYOND their planned stop (median move ${exitVsStop.medianBeyondPct.toFixed(2)}% against a stop at ${exitVsStop.medianBeyondStopPct.toFixed(2)}%): the stop fired late or slipped through its trigger (thin book, or the mark price crossed while the last price did not).`);
    }
    if (exitVsStop.atStop / exitVsStop.n >= 0.5) {
      findings.push(`${exitVsStop.atStop} of ${exitVsStop.n} losing trades closed AT their planned stop: the exits work as designed, so the loss rate is a question of entry quality and stop distance, not of the guard.`);
    }
  }
  if (lossHold && winHold && winHold < lossHold * 0.5) findings.push(`Winners are held ${winHold.toFixed(0)} min vs losers ${lossHold.toFixed(0)} min: profits are taken fast, losses are allowed to run.`);
  const worst = reasons[0];
  if (worst && worst.pnl < 0) findings.push(`Biggest loss bucket: close_reason "${worst.reason}" - ${worst.n} trades, PnL ${worst.pnl.toFixed(4)}.`);

  return {
    trades: t.length, wins: wins.length, losses: losses.length, pnl: t.reduce((a, x) => a + x.pnl, 0),
    winRate, avgWin, avgLoss, breakEvenWinRate, medianPlannedSlPct: medSl, medianPlannedTpPct: medTp,
    avgWinMovePct: avgWinMove, avgLossMovePct: avgLossMove, avgHoldWinMin: winHold, avgHoldLossMin: lossHold,
    breakEvenWinRatePriceFee: beFee, winRateCI: ci, avgNotionalWin: notW, avgNotionalLoss: notL, leverages,
    stopOuts: {
      n: slHits.length, total: stopOuts.length, measured,
      reachedHalfTarget: reachedHalf, neverWorked, medianBestMovePct: medMfeSl,
      beyondTpHi, beyondTpLo, armedButLost: armed, neverArmed: notArmed, bestMoveBuckets,
    },
    longs, shorts: t.length - longs, entryContext: ctx,
    exitVsStop, flatLosses: flatLosses.length,
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
        const end = new Date(r.closed_at).getTime();
        // MARK_PRICE candles: the bot's TP and SL both trigger on the mark price (tpStopType/slStopType),
        // so a last-price wick that never moved the mark price must not count as "touched the target".
        // tradeCandles() walks the window back and filters it: the endpoint ignores startTime,
        // so asking for a 4-minute window used to answer the previous 200 minutes instead.
        const candles = await tradeCandles({ symbol: r.symbol, from: start, to: end });
        const ex = excursion(candles, { side: r.side, entry: Number(r.entry_price) });
        if (ex) { r.mfePct = ex.mfePct; r.maePct = ex.maePct; r.mfeAfterEntryPct = ex.mfeAfterEntryPct; done += 1; }
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
        // Same trap as the excursion window: filter to the two hours before the
        // entry instead of trusting the endpoint to honour startTime.
        const candles = bars(raw).filter((c) => c.time >= end - 2 * 3600_000 && c.time <= end);
        const cx = entryContext(candles, { side: r.side, entry: Number(r.entry_price) });
        if (cx) { r.chase = cx.chase; r.runPct = cx.runPct; n += 1; }
      } catch (e) { note = note || `candles unavailable for some trades: ${e.message}`; }
    }
  }
  return { days: d, note, breakevenRoi: Number(settings().breakeven_threshold), ...summarize(rows, { breakevenRoi: Number(settings().breakeven_threshold) }) };
}
