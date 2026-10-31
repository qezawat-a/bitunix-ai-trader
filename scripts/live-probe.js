#!/usr/bin/env node
/**
 * LIVE, READ-ONLY probe of the guard loop's inputs.
 *
 * Run this ON THE MACHINE the bot runs on (it needs .env with Bitunix keys):
 *
 *     node scripts/live-probe.js
 *     node scripts/live-probe.js BEAMUSDT       # narrow to one symbol
 *
 * It answers, with no orders placed, the questions behind two recurring
 * mysteries:
 *
 *   1. LEVERAGE — does the exchange's held leverage for each symbol match the
 *      configured one, and does the ATR stop survive the HELD leverage?
 *      (2026-10-26: the bot sized a BEAMXUSDT order at a clamped 40x while
 *      the exchange kept holding 50x — the fill message lied and the real
 *      stop nearly hugged liquidation.)
 *
 *   2. BREAKEVEN/TRAILING — for each open position, exactly where the pending
 *      TP/SL rows are (RAW response shape included), which row the ratchet
 *      picks as the baseline, what the guard WOULD compute this pass
 *      (breakeven / trailing level), and WHY it would stay silent
 *      (ROI below threshold / no improvement / missing ATR).
 *
 * IMPORTANT: this script is a fresh process — it always runs the code as it
 * sits on disk RIGHT NOW. If the RUNNING bot behaves differently from what
 * this prints, the bot process is stale and needs a restart to pick up the
 * current code.
 */

import { config } from '../src/config.js';
import bitunix from '../src/exchange/bitunix.js';
import { positionRoi } from '../src/trading/manager.js';
import {
  trailingStop, breakevenStop, stopAtrFor, computeDynamicTpSl,
} from '../src/trading/risk.js';
import { mostProtectiveStopRow } from '../src/trading/tpsl.js';
import * as I from '../src/strategies/indicators.js';
import { getCandles } from '../src/scanner/scanner.js';
import { settings } from '../src/db/index.js';

const arg = process.argv[2] || null;
const f6 = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (v) => `${Number(v ?? 0).toFixed(2)}%`;

console.log('bitunix base:', config.bitunix.baseUrl, '| keys present:', Boolean(config.bitunix.key && config.bitunix.secret));
if (!config.bitunix.key || !config.bitunix.secret) {
  console.error('no Bitunix API keys in .env — private reads will fail');
}

const s = settings();
console.log('settings -> leverage(S):', s.leverage, '| margin_mode:', s.margin_mode,
  '| order_unit:', s.order_unit, '| timeframes:', s.timeframes);
console.log('guard settings -> breakeven_threshold:', s.breakeven_threshold, '% ROI | trailing_trigger_roi_pct:',
  s.trailing_trigger_roi_pct, '% | trailing_method:', s.trailing_method,
  '| trailing_distance_atr:', s.trailing_distance_atr, '| trailing_callback:', s.trailing_callback);
console.log('tp_mode:', s.tp_mode, '| min_stop_pct:', s.min_stop_pct, '| liq_distance:', s.liq_distance);
console.log('usage of this probe: breakeven fires at ROI >= thresholds.breakeven and stops trail at ROI >= thresholds.trailing — with real exchange numbers printed next.');
console.log('');

let positions;
try {
  positions = await bitunix.getPendingPositions();
} catch (e) {
  console.error('get_pending_positions failed:', e.message);
  process.exit(1);
}
positions = (Array.isArray(positions) ? positions : (positions?.data || [])).filter(Boolean);
if (arg) positions = positions.filter((p) => String(p.symbol).toUpperCase() === String(arg).toUpperCase());

if (!positions.length) {
  console.log('no open positions to guard.');
  process.exit(0);
}

for (const p of positions) {
  const side = p.side;
  const pid = String(p.positionId);
  const entry = f6(p.avgOpenPrice) || 0;
  const liq = f6(p.liqPrice);
  const notional = f6(p.entryValue) || (f6(p.qty) * entry);
  const roi = positionRoi({ unrealizedPNL: p.unrealizedPNL, leverage: p.leverage, notional, margin: p.margin, qty: p.qty });

  console.log('='.repeat(78));
  console.log(`${p.symbol} ${side} posId=${pid}`);
  console.log(`  qty ${p.qty} entry ${entry} notional(entryValue) ${notional} margin ${p.margin} leverage(held) ${p.leverage} liqPrice ${liq}`);
  console.log(`  unrealizedPNL ${p.unrealizedPNL} -> ROI ${pct(roi)} (positionRoi = pnl x leverage / notional)`);

  // --- SL read ------------------------------------------------------------
  let raw = null;
  try { raw = await bitunix.getPendingTpSlOrders({ symbol: p.symbol, positionId: pid }); }
  catch (e) { console.log('  tpsl read FAILED:', e.message); }
  const rows = Array.isArray(raw) ? raw : (raw?.orderList || []);
  console.log(`  tpsl raw shape: ${Array.isArray(raw) ? 'bare array' : 'object with orderList'} | rows: ${rows.length}`);
  for (const r of rows) {
    console.log(`    row id=${r.id} tp=${r.tpPrice ?? '-'} (tpStopType ${r.tpStopType ?? '-'}, tpQty ${r.tpQty ?? '-'})`
      + ` sl=${r.slPrice ?? '-'} (slStopType ${r.slStopType ?? '-'}, slQty ${r.slQty ?? '-'}) posId=${r.positionId}`);
  }
  const prot = mostProtectiveStopRow(rows, side);
  console.log(`  mostProtectiveStopRow (the ratchet baseline): ${prot ? prot.id + ' sl ' + prot.slPrice : 'NONE'}`);

  // --- candles / ATR ------------------------------------------------------
  const tfList = String(s.timeframes).split(',').map((x) => x.trim()).filter(Boolean);
  const tframes = {};
  let price = entry;
  for (const tf of tfList) {
    try {
      const cs = await getCandles(p.symbol, tf, 220);
      const a = I.last(I.atr(cs.map((c) => c.high), cs.map((c) => c.low), cs.map((c) => c.close), 14));
      price = I.last(cs.map((c) => c.close));
      if (Number.isFinite(a) && a > 0) tframes[tf] = { atr: a };
      console.log(`  ATR ${tf}: ${Number.isFinite(a) ? a.toFixed(8) : 'n/a'} (${a != null ? pct((a / price) * 100) : 'n/a'} of price) lastClose ${price}`);
    } catch (e) {
      console.log(`  ATR ${tf}: FETCH FAILED — ${e.message}`);
    }
  }
  const execAtr = tframes[tfList[0]]?.atr || null;
  const stopPick = stopAtrFor({ atr: execAtr, timeframes: tframes }, s);
  console.log(`  stopAtrFor -> ATR ${stopPick ? stopPick.atr?.toFixed(8) : 'none'} from ${stopPick?.tf}`);

  // --- what the guard WOULD do --------------------------------------------
  const be = breakevenStop({ side, entry, liqPrice: liq });
  console.log(`  breakeven floor: ${be.stop.toFixed(8)} (entry ${entry} +fee) — reason: ${be.reason}`);
  if (roi > 0) {
    const trail = trailingStop({
      side, entry, currentPrice: price,
      atr: (stopPick?.atr || execAtr) || 0,
      roiPct: roi, leverage: Number(p.leverage), liqPrice: liq,
    });
    if (!trail) {
      console.log(`  trailingStop: NOT armed — ROI ${pct(roi)} < breakeven_threshold ${s.breakeven_threshold}%`);
    } else {
      const baseline = prot ? Number(prot.slPrice) : null;
      const improved = baseline == null || (side === 'LONG' ? trail.stop > baseline * 1.0002 : trail.stop < baseline * 0.9998);
      console.log(`  guard decision: ${trail.reason} -> SL ${trail.stop.toFixed(8)}`);
      console.log(`  ratchet: baseline ${baseline ?? 'none'} -> improvement ${improved ? 'YES (stop would move)' : 'NO (stays put)'}`);
      if (!improved && baseline != null) {
        console.log(`  -> the stop the exchange holds is already at/inside the wanted level; nothing to write until price makes room.`);
      }
    }
  }

  // --- leverage consistency ------------------------------------------------
  // Mirror of openFromSignal's probe: price + candle ATRs + real MMR ->
  // maxSafeLeverage. If the exchange's HELD leverage exceeds it, a fresh
  // order here puts liquidation in front of the stop — the very clamp that
  // used to be applied only to the local sizing number.
  try {
    const held = await bitunix.getLeverageAndMarginMode(p.symbol);
    console.log(`  leverage HELD: ${held?.leverage}x | configured: ${s.leverage}x | marginMode(held) ${held?.marginMode}`);
    if (Number(held?.leverage) !== Number(s.leverage)) {
      console.log('  -> MISMATCH between configured and held leverage.');
    }
    const tier = await bitunix.tierFor({ symbol: p.symbol, notional }).catch(() => null);
    const probe = computeDynamicTpSl({
      symbol: p.symbol, side, price: entry,
      atr: execAtr, timeframes: tframes, regime: 'RANGE',
      confidence: Number(s.min_confidence), agreement: Number(s.min_agreement),
      leverage: Number(held?.leverage) || 1,
      maxLeverage: 125, mmr: tier ? Number(tier.mmr) : null,
    });
    console.log(`  executor probe at held leverage: stop is ${probe.slPct}% of price, maxSafeLeverage ${probe.maxSafeLeverage}x`
      + (probe.liqAdjusted ? ' — STOP WAS PULLED INSIDE LIQUIDATION (liq fires before the stop)' : ''));
    if (probe.maxSafeLeverage < Number(held?.leverage)) {
      console.log(`  -> the ATR stop only survives up to ~${probe.maxSafeLeverage}x but the exchange holds `
        + `${held?.leverage}x: a fresh order must change_leverage DOWN first — sizing at the clamped value is not enough.`);
    }
  } catch (e) {
    console.log('  leverage read failed:', e.message);
  }
}

console.log('');
console.log('READ-ONLY probe complete — no orders, no settings touched.');
console.log('If the bot’s behaviour disagrees with this print, the bot process is running stale code: restart it.');
process.exit(0);
