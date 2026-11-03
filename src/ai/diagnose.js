import { recentLogs } from '../logger.js';
import { getGuardTrace } from '../trading/trace.js';
import { settings, recentEvents, recentSignals, q } from '../db/index.js';

/**
 * "Why did X not happen?" answered from FACTS the process recorded, not from
 * guesses. Two layers:
 *
 *   1. explainTrailing()  - pure, deterministic. Walks the guard's own recorded
 *      decision (trace.js) and the live settings and names the first thing that
 *      stopped the stop from moving. Unit-testable, no network.
 *   2. diagnose()         - gathers that verdict plus recent warn/error logs,
 *      audit events and signals for the same symbol, so the LLM can explain
 *      anything the rules do not cover - citing evidence, not inventing.
 *
 * Every verdict carries a `category`:
 *   expected_behavior  - the bot did what its settings say (nothing to fix)
 *   config             - a setting explains it (change the setting)
 *   exchange           - the exchange refused / did not apply something
 *   possible_code_bug  - the recorded facts contradict the intended logic
 *   unknown            - not enough recorded evidence
 */

const f = (n, d = 2) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : String(n));

export function explainTrailing(trace, s, now = Date.now()) {
  if (!trace) {
    return {
      category: 'unknown',
      headline: 'The position guard has not recorded any pass for this position.',
      reasons: ['No guard trace exists: the manage loop has not evaluated it since the process started, or the position is not open.'],
    };
  }
  const gate = trace.stages.gate;
  const ev = trace.stages.trail_eval;
  const rat = trace.stages.ratchet;
  const wr = trace.stages.write;
  const every = Math.max(5, Number(s.manage_interval_sec ?? 15));
  const age = (now - trace.lastPassAt) / 1000;

  if (age > every * 4) {
    return {
      category: 'possible_code_bug',
      headline: `The guard last evaluated this position ${f(age, 0)}s ago (interval ${every}s) - the manage loop is stalled.`,
      reasons: ['Check recent loop_error events and warn/error logs: a throwing or hung loop stops every stop move.'],
    };
  }
  if (!gate?.inProfit) {
    return {
      category: 'expected_behavior',
      headline: `Position is not in profit (ROI ${f(gate?.roi)}%), so breakeven/trailing is not allowed to act yet.`,
      reasons: [`Trailing only runs while ROI > 0 and arms at breakeven_threshold=${s.breakeven_threshold}% ROI (trail trigger ${s.trailing_trigger_roi_pct}%).`],
    };
  }
  if (!ev) {
    return { category: 'unknown', headline: 'In profit but no trailing evaluation was recorded.', reasons: ['The guard reached the profit gate but not the trailing step.'] };
  }

  const roi = Number(ev.roi);
  const be = Number(ev.breakevenThreshold);
  const trig = Number(ev.trailingTriggerRoi);
  if (!ev.trailStop) {
    if (ev.method === 'ATR' || !ev.method) {
      return {
        category: 'expected_behavior',
        headline: `ROI ${f(roi)}% is below breakeven_threshold ${be}% - the stop is not armed yet.`,
        reasons: [`Leveraged ROI ${f(roi)}% < ${be}%. At ${gate.leverage}x that is a ${f(roi / gate.leverage, 3)}% price move; it needs ${f(be / gate.leverage, 3)}%.`],
      };
    }
    if (roi < be) {
      return { category: 'expected_behavior', headline: `ROI ${f(roi)}% is below breakeven_threshold ${be}%.`, reasons: [`Method ${ev.method} waits for ${be}% ROI first.`] };
    }
    return {
      category: roi >= trig ? 'possible_code_bug' : 'expected_behavior',
      headline: `Method ${ev.method}: ROI ${f(roi)}% but no trailing stop was produced.`,
      reasons: [roi >= trig
        ? `ROI is past the trigger (${trig}%) yet trailingStep() did not arm: price may not have reached the activation price, or the callback logic returned nothing. Verify trailingStep().`
        : `Between breakeven and trigger the breakeven floor should have been produced - it was not.`],
    };
  }

  const out = { category: 'expected_behavior', headline: '', reasons: [] };
  if (roi >= be && roi < trig) {
    out.headline = `ROI ${f(roi)}% is between breakeven (${be}%) and the trail trigger (${trig}%): only the breakeven floor applies, no trailing yet.`;
  } else if (roi >= trig && !(Number(ev.atr) > 0) && (ev.method === 'ATR' || !ev.method)) {
    out.category = 'possible_code_bug';
    out.headline = `ROI ${f(roi)}% is past the trigger but no ATR was available (source: ${gate.atrSource}), so the stop stayed on the breakeven floor.`;
    out.reasons.push('Candle feed for the execution timeframe returned nothing. Check warn logs for kline failures.');
  } else {
    out.headline = `Trailing was computed: wanted stop ${ev.trailStop} (${ev.trailReason}).`;
  }

  if (rat) {
    if (!rat.improved) {
      out.category = 'expected_behavior';
      out.reasons.push(`Not written because it is not an improvement: wanted ${rat.wanted}, exchange already has ${rat.exchangeStop ?? 'none'} (baseline ${rat.baseline}). The stop only ratchets one way.`);
    }
  }
  if (wr && wr.ok === false) {
    out.category = 'exchange';
    out.headline = `A stop move WAS computed (${wr.wanted}) but the write failed: ${wr.reason}.`;
    out.reasons.push(`The exchange still shows SL ${wr.exchangeSl ?? 'none'}. See stop_move_failed / tpsl_write_unverified events.`);
  } else if (wr?.ok) {
    out.reasons.push(`The stop move to ${wr.wanted} succeeded on the exchange.`);
  }
  return out;
}

/**
 * "Why did THIS closed trade end here?" — from the recorded prices only.
 *
 * After a loss the question is almost never "what did the market do", it is
 * "why did it close at -0.08% when the stop was recorded at -0.71%". That is
 * answerable from the trade row itself: the realised move against the stop and
 * the target the trade was opened with. `events` (audit rows around the same
 * symbol) are handed back alongside, because the answer "something else closed
 * it" needs them to name what.
 */
export function explainClosedTrade({ trade, events = [] } = {}) {
  if (!trade) return null;
  const entry = Number(trade.entry_price), exit = Number(trade.exit_price);
  const sl = Number(trade.sl_price), tp = Number(trade.tp_price);
  const isShort = String(trade.side || '').toUpperCase() === 'SHORT';
  const dir = isShort ? -1 : 1;
  const facts = {
    symbol: trade.symbol, side: isShort ? 'SHORT' : 'LONG',
    entry, exit, sl, tp, closedAt: trade.closed_at, closeReason: trade.close_reason || null,
    holdMin: trade.opened_at && trade.closed_at
      ? Math.round((new Date(trade.closed_at) - new Date(trade.opened_at)) / 60000) : null,
    pnl: Number(trade.realized_pnl),
  };
  if (!(entry > 0) || !Number.isFinite(exit)) {
    return { ...facts, category: 'unknown', verdict: 'The row has no usable entry/exit price.', reasons: [] };
  }
  const move = ((exit - entry) / entry) * 100 * dir;      // + in profit, - in loss
  const slPct = sl > 0 ? (Math.abs(sl - entry) / entry) * 100 : null;
  const tpPct = tp > 0 ? (Math.abs(tp - entry) / entry) * 100 : null;
  const out = {
    ...facts, movePct: move, slPct, tpPct,
    events: events.slice(0, 10).map((e) => ({ kind: e.kind, at: e.created_at, payload: e.payload })),
  };

  if (move > 0) {
    if (tpPct != null && move >= tpPct * 0.85) {
      return { ...out, category: 'expected_behavior', verdict: `Closed AT the target: +${move.toFixed(2)}% against a planned TP of ${tpPct.toFixed(2)}%.`, reasons: [] };
    }
    return {
      ...out, category: 'expected_behavior',
      verdict: `Closed in profit at +${move.toFixed(2)}%, well before the ${tpPct == null ? 'planned target' : tpPct.toFixed(2) + '% target'}: something took the profit early (trailing stop, breakeven floor, or a manual/agent close).`,
      reasons: ['Check the events below for a stop move right before the close, or a close_* event.'],
    };
  }
  if (slPct == null) {
    return { ...out, category: 'unknown', verdict: `Closed at ${move.toFixed(2)}% but the row has no planned stop to compare with.`, reasons: ['The trade was opened without a recorded stop, or the record is incomplete.'] };
  }
  const adverse = -move;
  if (adverse >= slPct * 0.85 && adverse <= slPct * 1.15) {
    return { ...out, category: 'expected_behavior', verdict: `Closed AT its plan: -${adverse.toFixed(2)}% against a planned stop of -${slPct.toFixed(2)}%. The exit did what it was told.`, reasons: [] };
  }
  if (adverse < slPct * 0.85) {
    return {
      ...out, category: 'possible_code_bug',
      verdict: `Closed at -${adverse.toFixed(2)}%, only ${((adverse / slPct) * 100).toFixed(0)}% of the way to the planned stop (-${slPct.toFixed(2)}%): the stop did not close this trade.`,
      reasons: [
        'Something else closed it: a software stop (see stop_move_failed / tpsl_write_unverified), an agent/manual close, an account-level TP/SL flatten, or the exchange held a stop tighter than the one recorded here.',
        'The events below are the evidence: look for account_tpsl, position_closed, stop_move_failed, tpsl_write_unverified or a partial-ladder row in the minutes before the close.',
      ],
    };
  }
  return {
    ...out, category: 'exchange',
    verdict: `Closed at -${adverse.toFixed(2)}%, BEYOND the planned stop of -${slPct.toFixed(2)}%: the stop fired late or the trigger slipped (mark price crossed while the last price did not, or a thin book).`,
    reasons: ['Compare the exchange position history row with the pending TP/SL at the time: the stop price that fired is not the one that was written down.'],
  };
}

export async function diagnose({ symbol = null, topic = 'trailing' } = {}) {
  const s = settings();
  const sym = symbol ? String(symbol).toUpperCase() : null;
  const traces = getGuardTrace({ symbol: sym });
  const verdicts = traces.map((t) => ({
    symbol: t.symbol, side: t.side, positionId: t.positionId,
    lastPassSecondsAgo: Math.round((Date.now() - t.lastPassAt) / 1000),
    ...explainTrailing(t, s),
    stages: t.stages,
  }));

  let events = [];
  try {
    events = (await recentEvents(80))
      .filter((e) => (!sym || e.symbol === sym || !e.symbol)
        && (/fail|error|reject|unverified|loop_error|close_failed|tpsl|stop_move|tp_lost/i.test(e.kind)
        || (topic !== 'trailing' && /ai_verdict|order_|position_opened/i.test(e.kind))))
      .slice(0, 12)
      .map((e) => ({ kind: e.kind, symbol: e.symbol, at: e.created_at, payload: e.payload }));
  } catch { /* DB offline: evidence is just thinner */ }

  let signals = [];
  if (topic !== 'trailing') {
    try { signals = (await recentSignals(8)).filter((x) => !sym || x.symbol === sym); } catch { /* ignore */ }
  }

  // "No open position has been evaluated by the guard" is the answer a user gets
  // AFTER the loss - the position is already closed, so there is no trace to
  // explain. Fall back to the last CLOSED trade on that symbol and answer the
  // question that was actually asked: why did it end there?
  let lastClosedTrade = null;
  if (sym && verdicts.length === 0) {
    try {
      const { rows } = await q(
        `SELECT symbol, side, entry_price, exit_price, sl_price, tp_price, realized_pnl,
                close_reason, opened_at, closed_at
           FROM trades WHERE symbol=$1 AND status='CLOSED' ORDER BY closed_at DESC LIMIT 1`, [sym]);
      lastClosedTrade = explainClosedTrade({ trade: rows[0] || null, events });
    } catch { /* DB offline: nothing to add */ }
  }

  const logs = recentLogs({ level: 'warn', grep: sym, limit: 25 })
    .concat(recentLogs({ level: 'error', limit: 15 }))
    .slice(-30);

  return {
    topic,
    symbol: sym,
    settings: {
      trailing_method: s.trailing_method, breakeven_threshold: s.breakeven_threshold,
      trailing_trigger_roi_pct: s.trailing_trigger_roi_pct, trailing_distance_atr: s.trailing_distance_atr,
      trailing_callback: s.trailing_callback, leverage: s.leverage, tpsl_method: s.tpsl_method,
      manage_interval_sec: s.manage_interval_sec, guard_interval_sec: s.guard_interval_sec,
    },
    positions: verdicts,
    noPositionsTraced: verdicts.length === 0,
    lastClosedTrade,
    recentFailureEvents: events,
    recentSignals: signals,
    recentWarnErrorLogs: logs,
    note: 'category possible_code_bug means the recorded facts contradict the intended logic: read the code (read_source) before proposing any fix. expected_behavior/config need no code change.',
  };
}
