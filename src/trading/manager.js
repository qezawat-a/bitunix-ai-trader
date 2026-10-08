import bitunix from '../exchange/bitunix.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { trailingStop, computeDynamicTpSl, stopAtrFor } from './risk.js';
import {
  trailingStep, resetTrailing, trailingSnapshot, evaluateAccountTpSl, closeEverything,
} from './tpsl.js';
import { upsertPositionTpSl, closePosition, forgetStop } from './executor.js';
import { getCandles } from '../scanner/scanner.js';
import * as I from '../strategies/indicators.js';
import {
  settings, openTrades, tradeByPosition, closeTrade, bumpStrategy,
  logEvent, remember, setCooldown,
} from '../db/index.js';

const log = createLogger('manager');

const lastStop = new Map();     // positionId -> last stop price we pushed
const softStops = new Map();    // positionId -> { side, stop } enforced by us when the exchange won't move it
const seenPositions = new Set();

/**
 * Forget the guard loop's per-process memory of what it has already done.
 *
 * `lastStop` is the ratchet state — it is what stops a trailing stop from
 * loosening when price retraces — so it is deliberately kept across passes.
 * That makes the module untestable in isolation: one scenario's stop would
 * suppress the next one's move. Exported for tests only; nothing in the
 * running system should call it.
 */
export function resetGuardState() {
  lastStop.clear();
  softStops.clear();
  seenPositions.clear();
}

/** ROI % on margin, the number the exchange UI shows.
 *
 * BUG FIX (2024-10): In CROSS margin mode the exchange returns `margin` as the
 * TOTAL ACCOUNT margin, not the position-specific margin. Dividing PnL by that
 * gives a near-zero ROI and breakeven/trailing never triggers.
 *
 * Fix: compute ROI from notional and leverage instead:
 *   ROI = (PnL / (notional / leverage)) * 100
 *       = (PnL * leverage / notional) * 100
 * This is correct for both CROSS and ISOLATION margin modes.
 */
export function positionRoi(p) {
  const pnl = Number(p.unrealizedPNL || 0);
  const leverage = Number(p.leverage || 1);
  const notional = Number(p.notional || (Number(p.qty || 0) * Number(p.avgOpenPrice || 0)));
  const margin = Number(p.margin || 0);

  // Primary path: notional + leverage works for both cross and isolated margin
  if (notional > 0 && leverage > 0) {
    return (pnl * leverage / notional) * 100;
  }

  // Fallback for isolated margin where margin is position-specific
  if (margin > 0) {
    return (pnl / margin) * 100;
  }

  return 0;
}

export async function livePositions() {
  const ps = await bitunix.getPendingPositions();
  if (!Array.isArray(ps)) return [];
  return (ps || []).map((p) => ({
    ...p,
    roi: positionRoi(p),
    // get_pending_positions returns `entryValue` — the exchange's own notional
    // figure (PositionPendingResp.entryValue). Prefer it over deriving from
    // qty x avgOpenPrice, which drifts once the position is part-closed and the
    // average entry no longer matches the live size. The derivation stays as
    // the fallback for rows that predate the field or come from the WS push.
    notional: Number(p.entryValue || (Number(p.qty || 0) * Number(p.avgOpenPrice || 0))),
    unrealizedPNL: Number(p.unrealizedPNL || 0),
    qty: Number(p.qty || 0),
    margin: Number(p.margin || 0),
    avgOpenPrice: Number(p.avgOpenPrice || 0),
    leverage: Number(p.leverage || 0),
  }));
}

/**
 * Position guard — runs every manage_interval_sec / guard_interval_sec.
 *  - makes sure every open position HAS a TP/SL (dynamic, ATR based)
 *  - moves the stop to breakeven at breakeven_threshold ROI
 *  - trails the stop after trailing_trigger_roi_pct ROI
 *  - detects positions closed on the exchange and books the result in Neon
 */
export async function manageOpenPositions({ notify = null } = {}) {
  const s = settings();
  let positions;
  try {
    positions = await livePositions();
  } catch (e) {
    // exchange unreachable: do nothing rather than act on stale state
    log.warn(`cannot read positions, skipping management pass: ${e.message}`);
    return { positions: [], actions: [], degraded: e.message };
  }
  const actions = [];

  // ---- method 4: account-level TP/SL --------------------------------------
  // Checked first: if the whole book is being flattened there is no point
  // adjusting individual stops on the way out.
  const acct = evaluateAccountTpSl({
    positions,
    takeProfitUsdt: s.account_tp_usdt,
    stopLossUsdt: s.account_sl_usdt,
  });
  if (acct.hit) {
    const r = await closeEverything(acct.reason);
    actions.push({ type: 'account_tpsl', side: acct.side, totalPnl: acct.totalPnl, ok: r.ok });
    await logEvent('account_tpsl', { ...acct, ok: r.ok });
    if (notify) {
      await notify(`${acct.side === 'TAKE_PROFIT' ? '🎯' : '🛑'} *Account ${acct.side === 'TAKE_PROFIT' ? 'take-profit' : 'stop-loss'}* — closing every position\n${acct.reason}`);
    }
    return { positions, actions, accountTpSl: acct };
  }

  const liveIds = new Set(positions.map((p) => String(p.positionId)));
  for (const id of Object.keys(trailingSnapshot())) {
    if (!liveIds.has(id)) resetTrailing(id);
  }

  // ---- book positions that disappeared (TP/SL hit or manual close) ----
  for (const t of await openTrades()) {
    if (!t.position_id || liveIds.has(String(t.position_id))) continue;
    try {
      const hist = await bitunix.getHistoryPositions({ positionId: t.position_id, limit: 1 });
      // The SDK documents { positionList: [...] } but get_history_positions has
      // answered with a bare array before. Reading only .positionList meant h
      // was undefined on such a response, so the trade was booked with pnl 0
      // and a null exit price: every closed position looked like a flat loss,
      // bumpStrategy learned from a number that never happened, and the lesson
      // written into memory said LOSS for a winning trade. Normalise first.
      const h = (Array.isArray(hist) ? hist[0] : hist?.positionList?.[0]) || null;
      if (!h) { log.warn(`${t.position_id}: history returned no row — left open, will retry next pass`); continue; }
      const pnl = Number(h?.realizedPNL ?? 0) - Number(h?.fee ?? 0) + Number(h?.funding ?? 0);
      const roi = t.margin_usdt ? (pnl / Number(t.margin_usdt)) * 100 : null;
      await closeTrade({
        positionId: t.position_id,
        exitPrice: h?.closePrice ? Number(h.closePrice) : null,
        realizedPnl: pnl, roiPct: roi, reason: 'exchange_close',
      });
      for (const st of (t.strategies || [])) await bumpStrategy(st, pnl > 0, pnl);
      await remember({
        kind: 'lesson', subject: t.symbol, importance: pnl > 0 ? 5 : 7,
        content: `${t.side} ${t.symbol} closed ${pnl > 0 ? 'WIN' : 'LOSS'} ${pnl.toFixed(4)} USDT `
          + `(ROI ${roi?.toFixed(1)}%) — strategies: ${(t.strategies || []).join(', ')}, `
          + `entry ${t.entry_price}, conf ${t.confidence}, agreement ${t.agreement}.`,
      });
      await setCooldown(t.symbol, Number(s.cooldown_min), 'position closed');
      forgetStop(t.position_id);
      actions.push({ type: 'booked', symbol: t.symbol, pnl, roi });
      if (notify) {
        await notify(
          `${pnl >= 0 ? '🟢' : '🔴'} *Position closed* — ${t.symbol} ${t.side}\n`
          + `PnL: ${pnl.toFixed(4)} USDT  (ROI ${roi != null ? roi.toFixed(1) : '?'}%)\n`
          + `Entry ${t.entry_price} → Exit ${h?.closePrice ?? '?'}`,
        );
      }
    } catch (e) { log.warn(`booking ${t.position_id}: ${e.message}`); }
  }

  // ---- guard each live position --------------------------------------
  for (const p of positions) {
    const pid = String(p.positionId);
    const record = await tradeByPosition(pid);

    // candles for ATR
    let atr = null, price = Number(p.avgOpenPrice);
    try {
      // Same rule as the scanner: the fallback is the configured default, not a
      // stale copy of it. The first timeframe is the execution one — it still
      // fixes the PRICE here; stop SIZING now goes through stopAtrFor.
      const tf = String(s.timeframes || config.defaults.timeframes).split(',')[0].trim();
      const candles = await getCandles(p.symbol, tf, 220);
      atr = I.last(I.atr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14));
      price = I.last(candles.map((c) => c.close));
    } catch {}

    // Per-TF ATRs, so the guard sizes stops with the SAME structure-TF policy
    // as the executor (stopAtrFor). Trailing on the execution-TF ATR was
    // fee-band too: "trailing 0.5 ATR" of a 1m bar is a fraction of a cent of
    // price — tighter than the round trip it is supposed to trail.
    let tframes = {};
    for (const t of String(s.timeframes || config.defaults.timeframes).split(',').map((x) => x.trim()).filter(Boolean)) {
      try {
        const cs = await getCandles(p.symbol, t, 220);
        const a = I.last(I.atr(cs.map((c) => c.high), cs.map((c) => c.low), cs.map((c) => c.close), 14));
        if (Number.isFinite(a) && a > 0) tframes[t] = { atr: a };
      } catch {}
    }
    const stopPick = stopAtrFor({ atr, timeframes: tframes }, s);

    // 0) software stop: the exchange refused to move the SL earlier, so enforce
    //    the wanted level ourselves. Without this a winner reverses into a loss
    //    while the original wide stop sits untouched.
    const soft = softStops.get(pid);
    if (soft) {
      const crossed = soft.side === 'LONG' ? price <= soft.stop : price >= soft.stop;
      if (crossed) {
        log.warn(`${p.symbol}: software stop ${soft.stop} hit at ${price} — closing`);
        const c = await closePosition(pid, 'software_stop');
        actions.push({ type: 'software_stop', symbol: p.symbol, stop: soft.stop, price, ok: c?.ok !== false });
        if (notify) await notify(`🛡 *Software stop* — ${p.symbol} ${p.side} closed at ~${price} (stop ${soft.stop})`);
        if (c?.ok !== false) softStops.delete(pid);
        continue;
      }
    }

    // 1) position with no TP/SL at all -> attach one now (never leave naked)
    //
    // This read MUST distinguish "the position has no stop" from "I could not
    // ask". Swallowing the error and treating it as an empty list meant a
    // transient API failure looked like a naked position, and the rescue below
    // then wrote a fresh ATR stop over a trailing stop that was already
    // locking in profit — widening it back out to entry distance. A stop that
    // had ratcheted to 164.81 on a short from 165.41 was reset to 168.19, so
    // when price came back it sailed straight through the level that should
    // have closed the trade.
    let tpsl = null;
    try {
      tpsl = await bitunix.getPendingTpSlOrders({ symbol: p.symbol, positionId: pid }) || [];
    } catch (e) {
      log.warn(`${p.symbol}: cannot read TP/SL (${e.message}) — leaving the existing one alone`);
      tpsl = null;
    }
    if (tpsl && !tpsl.length && atr) {
      const synth = computeDynamicTpSl({
        symbol: p.symbol, side: p.side, price: Number(p.avgOpenPrice) || price, atr,
        timeframes: tframes,
        confidence: Number(record?.confidence || s.min_confidence),
        agreement: Number(record?.agreement || s.min_agreement),
        atrPct: (atr / price) * 100, regime: 'RANGE',
        leverage: Number(p.leverage) || null,
        maxLeverage: Number((await bitunix.pairInfo(p.symbol))?.maxLeverage) || null,
        // real maintenance margin rate for this position's notional
        mmr: await bitunix.tierFor({
          symbol: p.symbol,
          notional: Number(p.qty) * (Number(p.avgOpenPrice) || price),
        }).then((t) => t.mmr).catch(() => null),
        // use the exchange's real liquidation price, not an estimate: this
        // position already exists, so there is nothing to guess about
        liqPrice: Number(p.liqPrice) || null,
      });
      if (synth.liqAdjusted) {
        log.warn(`${p.symbol}: rescue stop clamped inside liq — ${synth.liqNote}`);
      }
      const r = await upsertPositionTpSl({
        symbol: p.symbol, positionId: pid, tpPrice: synth.tpPrice, slPrice: synth.slPrice,
        side: p.side, entry: Number(p.avgOpenPrice) || price,
      });
      if (r.ok) lastStop.set(pid, r.slPrice ?? synth.slPrice);
      actions.push({ type: 'tpsl_attached', symbol: p.symbol, ok: r.ok, tp: synth.tpPrice, sl: synth.slPrice });
      if (notify && r.ok) {
        await notify(`🛡 *TP/SL attached* — ${p.symbol} ${p.side}\nTP ${synth.tpPrice.toPrecision(8)} | SL ${synth.slPrice.toPrecision(8)}  (${synth.explain})`
          + (synth.liqAdjusted ? `\n⚠️ stop pulled inside liquidation (${Number(p.liqPrice).toPrecision(8)}) — ${p.leverage}x is too high for this ATR` : ''));
      }
      continue;
    }

    // 2) breakeven + trailing
    if (atr && p.roi > 0) {
      // method 3: two trailing families.
      //   ATR              — the original: breakeven, then a stop N ATR behind.
      //   RATIO / INTERVAL — the exchange's own semantics (help centre id=290):
      //                      arm at an activation price, then close once price
      //                      retraces by a callback from the BEST price seen.
      // Both end up writing a native stop, so the exchange still protects the
      // position if this process dies mid-trend.
      const tm = String(s.trailing_method || 'ATR').toUpperCase();
      let trail = null;
      if (tm === 'ATR') {
        trail = trailingStop({
          side: p.side, entry: Number(p.avgOpenPrice), currentPrice: price,
          // structure-TF ATR (stopAtrFor): trailing on the 1m bar is
          // fee-band — the stop barely ratchets and hands the win back.
          atr: stopPick?.atr || atr, roiPct: p.roi, leverage: Number(p.leverage),
          // the exchange's own liquidation price — authoritative, unlike an estimate
          liqPrice: Number(p.liqPrice) || null,
        });
      } else if (p.roi >= Number(s.trailing_trigger_roi_pct || 25)) {
        // activation expressed as the price at which trailing_trigger_roi_pct
        // of ROI is reached, so one setting drives both trailing families
        const entry = Number(p.avgOpenPrice);
        const lev = Number(p.leverage) || 1;
        const move = (entry * Number(s.trailing_trigger_roi_pct || 25)) / (100 * lev);
        const activationPrice = p.side === 'LONG' ? entry + move : entry - move;
        const step = trailingStep({
          side: p.side, entry, price, activationPrice,
          callback: Number(s.trailing_callback ?? 1.5), mode: tm,
          positionId: pid, liqPrice: Number(p.liqPrice) || null,
        });
        if (step.armed) trail = { stop: step.stop, reason: step.reason };
      }
      if (trail) {
        // Ratchet against what the EXCHANGE has, not against our own memory of
        // what we wrote. `lastStop` used to be the only baseline, so once the
        // two disagreed — a write that reported success but never landed, or a
        // restart — the guard computed a perfectly good breakeven stop, saw
        // "not an improvement" against its own phantom value, and returned an
        // empty action list on every pass while the position kept the original
        // wide stop. The exchange is the source of truth; lastStop is only a
        // fallback for when the read is unavailable.
        const exchangeRow = (tpsl || []).filter((r) => r && r.slPrice != null)
          .reduce((a, b) => (!a ? b : (p.side === 'LONG'
            ? (Number(b.slPrice) > Number(a.slPrice) ? b : a)
            : (Number(b.slPrice) < Number(a.slPrice) ? b : a))), null);
        const exchangeStop = exchangeRow ? Number(exchangeRow.slPrice) : null;
        const baseline = exchangeStop != null && Number.isFinite(exchangeStop)
          ? exchangeStop
          : lastStop.get(pid);
        const improved = baseline == null
          || (p.side === 'LONG' ? trail.stop > baseline * 1.0002 : trail.stop < baseline * 0.9998);
        if (improved) {
          // preserve the existing take-profit, but read it off the
          // whole-position row rather than whatever row happened to be first
          const tpRow = (tpsl || []).find((r) => r && r.tpPrice != null) || null;
          const existingTp = tpRow ? Number(tpRow.tpPrice) : null;
          const r = await upsertPositionTpSl({
            symbol: p.symbol, positionId: pid, slPrice: trail.stop, tpPrice: existingTp,
            side: p.side, entry: Number(p.avgOpenPrice),
          });
          if (r.ok) {
            softStops.delete(pid);
            lastStop.set(pid, trail.stop);
            actions.push({ type: 'stop_moved', symbol: p.symbol, stop: trail.stop, reason: trail.reason, roi: p.roi });
            if (notify) {
              await notify(`🔒 *Stop moved* — ${p.symbol} ${p.side}\nROI ${p.roi.toFixed(1)}% → SL ${trail.stop.toPrecision(8)} (${trail.reason})`);
            }
          } else {
            // Do NOT set lastStop here. Leaving it unset is what lets the next
            // pass retry instead of treating the phantom stop as done.
            log.error(`${p.symbol} ${p.side}: stop move FAILED (${r.reason})`);
            softStops.set(pid, { side: p.side, stop: trail.stop });
            actions.push({
              type: 'stop_move_failed', symbol: p.symbol, side: p.side,
              wanted: trail.stop, exchangeSl: r.exchangeSl ?? null, reason: r.reason, roi: p.roi,
            });
            await logEvent('stop_move_failed', {
              symbol: p.symbol, side: p.side, positionId: pid, wanted: trail.stop,
              exchangeSl: r.exchangeSl ?? null, reason: r.reason, roi: p.roi,
            }, p.symbol);
            if (notify) {
              await notify(
                `⚠️ *Stop move failed* — ${p.symbol} ${p.side}\n`
                + `wanted SL ${trail.stop.toPrecision(8)} (${trail.reason}) · `
                + `exchange still shows ${r.exchangeSl != null ? r.exchangeSl : 'no stop'}\n`
                + `The exchange accepted the request but did not change the order. `
                + `Move the stop by hand until this clears.`,
              );
            }
          }
        }
      }
    }

    if (!seenPositions.has(pid)) {
      seenPositions.add(pid);
      await logEvent('position_seen', { symbol: p.symbol, side: p.side, qty: p.qty }, p.symbol);
    }
  }

  return { positions, actions };
}

/**
 * Reversal engine: if an open position has a high-confidence opposite signal,
 * flip it (close + open the other way).
 */
export async function checkReversal(signals) {
  const s = settings();
  if (!s.reversal_enabled) return [];
  const minConf = Number(s.reversal_confidence || 85);
  let positions = [];
  try { positions = await livePositions(); }
  catch (e) { log.warn(`checkReversal: ${e.message}`); return []; }
  const out = [];

  for (const p of positions) {
    const sig = signals.find((x) => x.symbol === p.symbol);
    if (!sig) continue;
    const opposite = (p.side === 'LONG' && sig.side === 'SHORT') || (p.side === 'SHORT' && sig.side === 'LONG');
    if (!opposite) continue;
    if (sig.confidence < minConf) continue;
    if (sig.agreement < Number(s.min_agreement)) continue;
    out.push({ position: p, signal: sig });
  }
  return out;
}

export async function portfolioSnapshot() {
  const positions = await livePositions();
  if (!positions.length) return { count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] };
  const totalPnl = positions.reduce((a, p) => a + p.unrealizedPNL, 0);
  const totalMargin = positions.reduce((a, p) => a + p.margin, 0);
  return {
    count: positions.length,
    totalPnl,
    totalMargin,
    roi: totalMargin ? (totalPnl / totalMargin) * 100 : 0,
    positions,
  };
}

/**
 * Realised performance, read from the EXCHANGE rather than our own table.
 *
 * The `trades` table is only written by openFromSignal, so it contains bot
 * entries and nothing else. Anything opened by hand, opened before this bot
 * ran, or opened while auto_trade was off is invisible to it — which is why
 * /pnl read 0 trades and +0.00 PnL on an account that had actually traded.
 *
 * get_history_positions is the account's own record and covers all of it.
 * Fields (PositionHistoryResp): realizedPNL, fee, funding, ctime, mtime.
 *
 * Fee and funding are reported separately rather than folded into the total:
 * their sign convention is not documented, and quietly adding them with the
 * wrong sign would misstate performance in exactly the direction that flatters
 * it. realizedPNL is the headline; the other two are shown next to it.
 */
export async function exchangePerformance(days = 7, { symbol = null } = {}) {
  const endTime = Date.now();
  const startTime = endTime - days * 86_400_000;

  const rows = [];
  const PAGE = 100;
  for (let skip = 0; skip < 1000; skip += PAGE) {
    let page;
    try {
      page = await bitunix.getHistoryPositions({ symbol, startTime, endTime, skip, limit: PAGE });
    } catch (e) {
      if (!rows.length) throw e;      // nothing at all: let the caller report it
      break;                          // partial data is still worth showing
    }
    const list = Array.isArray(page) ? page : (page?.positionList || []);
    if (!list.length) break;
    rows.push(...list);
    if (list.length < PAGE) break;
  }

  // the window filter is applied server-side, but closed-at can be null on a
  // partially closed position, so keep only rows that really closed in range
  const closed = rows.filter((r) => {
    const t = Number(r.mtime || r.ctime || 0);
    return t >= startTime && t <= endTime;
  });

  let pnl = 0; let fees = 0; let funding = 0; let wins = 0; let losses = 0;
  for (const r of closed) {
    const p = Number(r.realizedPNL || 0);
    pnl += p;
    fees += Number(r.fee || 0);
    funding += Number(r.funding || 0);
    if (p > 0) wins++; else if (p < 0) losses++;
  }

  return {
    source: 'exchange',
    days,
    trades: closed.length,
    wins,
    losses,
    pnl,
    fees,
    funding,
    net: pnl + fees + funding,
  };
}
