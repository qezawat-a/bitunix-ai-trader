import bitunix from '../exchange/bitunix.js';
import { createLogger } from '../logger.js';
import { orderGotFill, orderRejected } from '../exchange/errors.js';
import { computeDynamicTpSl, computeMargin } from './risk.js';
import { applyPartialTpSl, entryMethod, mostProtectiveStopRow } from './tpsl.js';
import {
  settings, openTrade, attachPositionId, logEvent, setCooldown, remember,
} from '../db/index.js';

const log = createLogger('executor');

/**
 * LIVE order execution on Bitunix futures.
 * There is no dry-run path in this module — every call hits the real exchange.
 */

const leverageApplied = new Map();   // symbol -> {leverage, marginMode}
let positionModeApplied = null;

/** Make sure position mode / margin mode / leverage match the settings. */
export async function ensureSymbolConfig(symbol, overrideLev = null) {
  const s = settings();
  const wantLev = Number(overrideLev ?? s.leverage);
  const wantMargin = String(s.margin_mode).toUpperCase() === 'ISOLATED'
    ? 'ISOLATION' : String(s.margin_mode).toUpperCase();   // docs enum: ISOLATION | CROSS
  const wantPosMode = String(s.position_mode).toUpperCase();

  if (positionModeApplied !== wantPosMode) {
    try {
      await bitunix.changePositionMode(wantPosMode);
      positionModeApplied = wantPosMode;
      log.info(`position mode -> ${wantPosMode}`);
    } catch (e) {
      // 30005 / 20009: cannot change with open positions — read actual mode instead
      try {
        const acc = await bitunix.getAccount();
        const actual = Array.isArray(acc) ? acc[0]?.positionMode : acc?.positionMode;
        positionModeApplied = actual || wantPosMode;
        log.warn(`position mode stays ${positionModeApplied} (${e.message})`);
      } catch {}
    }
  }

  const cached = leverageApplied.get(symbol);
  if (cached && cached.leverage === wantLev && cached.marginMode === wantMargin) return;

  let current = null;
  try { current = await bitunix.getLeverageAndMarginMode(symbol); } catch {}

  if (!current || String(current.marginMode).toUpperCase() !== wantMargin) {
    try { await bitunix.changeMarginMode({ symbol, marginMode: wantMargin }); }
    catch (e) { log.warn(`${symbol} margin mode: ${e.message}`); }
  }
  if (!current || Number(current.leverage) !== wantLev) {
    // respect the pair's tier limits
    const info = await bitunix.pairInfo(symbol);
    const lev = Math.max(Number(info?.minLeverage ?? 1),
      Math.min(Number(info?.maxLeverage ?? 125), wantLev));
    try { await bitunix.changeLeverage({ symbol, leverage: lev }); }
    catch (e) { log.warn(`${symbol} leverage: ${e.message}`); }
  }
  leverageApplied.set(symbol, { leverage: wantLev, marginMode: wantMargin });
}

export function resetSymbolConfigCache() {
  leverageApplied.clear();
  positionModeApplied = null;
}

/** Available USDT (available + cross unrealised PnL, per docs note). */
export async function availableBalance() {
  const acc = await bitunix.getAccount();
  const a = Array.isArray(acc) ? acc[0] : acc;
  if (!a) return { available: 0, raw: null };
  const available = Number(a.available || 0) + Number(a.crossUnrealizedPNL || 0);
  return {
    available,
    margin: Number(a.margin || 0),
    frozen: Number(a.frozen || 0),
    bonus: Number(a.bonus || 0),
    positionMode: a.positionMode,
    unrealized: Number(a.crossUnrealizedPNL || 0) + Number(a.isolationUnrealizedPNL || 0),
    raw: a,
  };
}

/**
 * Open a position from a qualified signal.
 * HEDGE mode:  side BUY  + tradeSide OPEN -> long
 *              side SELL + tradeSide OPEN -> short
 * TP/SL are attached dynamically (ATR + signal strength), never static.
 */
export async function openFromSignal(signal, { aiVerdict = null, marginOverride = null } = {}) {
  const s = settings();
  const symbol = signal.symbol;

  await ensureSymbolConfig(symbol);

  const bal = await availableBalance();
  const positions = await bitunix.getPendingPositions();
  const openCount = (positions || []).length;
  if (openCount >= Number(s.max_open_positions)) {
    return { ok: false, reason: `max_open_positions reached (${openCount})` };
  }
  if ((positions || []).some((p) => p.symbol === symbol
    && p.side === (signal.side === 'LONG' ? 'LONG' : 'SHORT'))) {
    return { ok: false, reason: `already in ${signal.side} on ${symbol}` };
  }

  const marginUsdt = marginOverride != null
    ? Number(marginOverride)
    : computeMargin({
      available: bal.available,
      marginPct: s.margin_pct,
      openPositions: openCount,
      maxPositions: Number(s.max_open_positions),
    });

  if (!(marginUsdt > 0)) return { ok: false, reason: 'no available margin' };

  // live price from tickers (mark price preferred)
  const tick = await bitunix.getTickers(symbol);
  const t = Array.isArray(tick) ? tick[0] : tick;
  const price = Number(t?.markPrice || t?.lastPrice || signal.price);
  if (!price) return { ok: false, reason: 'no price' };

  const info = await bitunix.pairInfo(symbol);
  let leverage = Math.max(Number(info?.minLeverage ?? 1),
    Math.min(Number(info?.maxLeverage ?? 125), Number(s.leverage)));

  // ---- de-lever so the ATR stop fits inside liquidation -----------------
  // The stop distance comes from ATR and does not shrink when leverage grows,
  // but the liquidation price marches toward entry as leverage grows. Past a
  // certain leverage the stop sits BEYOND liq and the position can only ever
  // be liquidated. Rather than open that trade, cut the leverage to fit.
  {
    const maxLev = Number(info?.maxLeverage);

    // Risk tier lookup. Both the maintenance margin rate AND the maximum
    // leverage depend on the position's notional value, so a big position on
    // a thin pair silently loses access to high leverage. Ask the exchange
    // rather than guessing: get_position_tiers is authoritative.
    let mmr = null;
    try {
      const tier = await bitunix.tierFor({ symbol, notional: marginUsdt * leverage });
      mmr = tier.mmr;
      if (tier.leverage < leverage) {
        log.warn(`${symbol}: tier L${tier.level} (notional up to ${tier.endValue}) caps leverage at ${tier.leverage}x, requested ${leverage}x`);
        await logEvent('leverage_reduced', {
          symbol, requested: leverage, applied: tier.leverage,
          reason: `risk tier L${tier.level} maximum`, tier,
        }, symbol);
        leverage = tier.leverage;
        await ensureSymbolConfig(symbol, leverage);
      }
    } catch (e) {
      log.warn(`${symbol}: position tiers unavailable (${e.message}); falling back to the maxLeverage heuristic`);
    }

    const probe = computeDynamicTpSl({ ...signal, price, leverage: 1, maxLeverage: maxLev, mmr });
    const atLev = computeDynamicTpSl({ ...signal, price, leverage, maxLeverage: maxLev, mmr });
    if (atLev.liqUnsafe) {
      return { ok: false, reason: `refusing ${symbol}: at ${leverage}x liquidation sits at the entry price` };
    }
    const safeLev = probe.maxSafeLeverage;
    if (safeLev < leverage) {
      const floor = Math.max(Number(info?.minLeverage ?? 1), Number(s.min_leverage ?? 1));
      const cut = Math.max(floor, Math.min(leverage, safeLev));
      log.warn(`${symbol}: ${leverage}x would liquidate before the ${probe.slPct}% stop; using ${cut}x`);
      await logEvent('leverage_reduced', {
        symbol, requested: leverage, applied: cut, stopPct: probe.slPct, reason: 'stop beyond liquidation',
      }, symbol);
      if (safeLev < floor) {
        return { ok: false, reason: `refusing ${symbol}: even ${floor}x liquidates before a ${probe.slPct}% ATR stop` };
      }
      leverage = cut;
      // the exchange must agree, otherwise qty and liq are computed off a
      // leverage the position does not actually have
      await ensureSymbolConfig(symbol, leverage);
    }
  }

  // The sizing engine always produces a USDT figure to commit (marginUsdt).
  // order_unit decides how that figure is interpreted on the way to base qty:
  //   COST     -> it is the margin; notional = margin * leverage   (default)
  //   NOMINAL  -> it is the position value; margin = value / leverage
  //   QTY      -> the agent supplied base coin directly
  // See bitunix.sizeOrder() for the doc-derived formulas.
  const unit = String(s.order_unit || 'COST').toUpperCase();
  const amount = unit === 'QTY' && signal.qty != null ? Number(signal.qty) : marginUsdt;
  let sized;
  try {
    sized = await bitunix.sizeOrder({ symbol, unit, amount, leverage, price });
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const qty = sized.qty;
  if (Number(qty) <= 0) return { ok: false, reason: 'computed qty is 0 (increase margin_pct)' };
  log.info(`${symbol} size: unit ${unit} · qty ${qty} · cost ${sized.cost.toFixed(2)} USDT · notional ${sized.nominal.toFixed(2)} USDT @ ${leverage}x`);

  const minQty = Number(info?.minTradeVolume ?? 0);
  if (minQty && Number(qty) < minQty) {
    return { ok: false, reason: `qty ${qty} below minTradeVolume ${minQty} for ${symbol}` };
  }

  // The pair's own ceilings, from GET /api/v1/futures/market/trading_pairs:
  //   minTradeVolume         minimum opening amount (base currency)
  //   maxMarketOrderVolume   maximum market order base amount
  //   maxLimitOrderVolume    maximum limit order base amount
  //   symbolStatus           OPEN | CANCEL_ONLY | STOP
  //   isApiSupported         false = API trading disabled
  // Only the min was ever checked, so an oversized order was discovered by
  // being rejected at the exchange rather than before it was sent. A position
  // that is simply too big for the pair should be refused and explained, not
  // attempted and logged as an exchange error.
  const maxQty = Number(info?.maxMarketOrderVolume ?? 0);
  if (maxQty && Number(qty) > maxQty) {
    return {
      ok: false,
      reason: `qty ${qty} above maxMarketOrderVolume ${maxQty} for ${symbol} `
        + `— lower margin_pct or leverage`,
    };
  }
  if (info && String(info.symbolStatus || 'OPEN').toUpperCase() === 'STOP') {
    return { ok: false, reason: `${symbol} is STOP — the pair cannot open or close positions` };
  }
  if (info && info.isApiSupported === false) {
    return { ok: false, reason: `${symbol} has API trading disabled (isApiSupported=false)` };
  }

  let realMmr = null;
  try { realMmr = (await bitunix.tierFor({ symbol, notional: marginUsdt * leverage })).mmr; } catch {}
  const risk = computeDynamicTpSl({
    ...signal, price, leverage, maxLeverage: Number(info?.maxLeverage), mmr: realMmr,
  });
  if (risk.liqAdjusted) log.warn(`${symbol}: ${risk.liqNote}`);
  // A null tpPrice is deliberate: in ADAPTIVE mode a strong, expanding trend
  // gets NO fixed target so the trailing stop can decide when the move ends.
  // The stop is never optional.
  const tpPrice = risk.tpPrice == null ? null : await bitunix.roundPrice(symbol, risk.tpPrice);
  const slPrice = await bitunix.roundPrice(symbol, risk.slPrice);
  if (tpPrice == null) log.info(`${symbol}: no fixed TP — ${risk.tpBasis}`);

  const isLong = signal.side === 'LONG';
  const clientId = `aria${Date.now().toString(36)}`;

  const order = {
    symbol,
    qty,
    side: isLong ? 'BUY' : 'SELL',
    orderType: 'MARKET',
    clientId,
    slPrice,
    slStopType: 'MARK_PRICE',
    slOrderType: 'MARKET',
  };
  if (tpPrice != null) {
    order.tpPrice = tpPrice;
    order.tpStopType = 'MARK_PRICE';
    order.tpOrderType = 'MARKET';
  }
  if (String(s.position_mode).toUpperCase() === 'HEDGE') order.tradeSide = 'OPEN';

  let res;
  try {
    res = await bitunix.placeOrder(order);
  } catch (e) {
    await logEvent('order_failed', { symbol, error: e.message, order }, symbol);
    await remember({
      kind: 'error', subject: symbol, importance: 6,
      content: `Order failed on ${symbol} ${signal.side}: ${e.message}`,
    });
    return { ok: false, reason: e.message };
  }

  // Confirm the order actually filled before booking a trade against it.
  // A MARKET order can still come back CANCELED (price protection, no
  // liquidity, margin recheck), and PART_FILLED_CANCELED means a real but
  // SMALLER position than we sized for — recording the requested qty in that
  // case would make every later PnL and stop calculation wrong.
  let filledQty = Number(qty);
  try {
    const detail = await bitunix.getOrderDetail({ orderId: res?.orderId, clientId });
    const d = Array.isArray(detail) ? detail[0] : detail;
    if (d?.status) {
      if (orderRejected(d.status)) {
        await logEvent('order_rejected', { symbol, status: d.status, orderId: res?.orderId }, symbol);
        return { ok: false, reason: `order ${d.status} — nothing filled` };
      }
      if (orderGotFill(d.status)) {
        const got = Number(d.tradeQty ?? d.dealQty ?? d.filledQty ?? 0);
        if (got > 0 && Math.abs(got - filledQty) / filledQty > 0.001) {
          log.warn(`${symbol}: ${d.status} — filled ${got} of ${filledQty}, booking the real size`);
          filledQty = got;
        }
      }
    }
  } catch (e) {
    log.warn(`${symbol}: could not confirm order status (${e.message}); assuming full fill`);
  }

  const tradeId = await openTrade({
    clientId, symbol, side: signal.side, entryPrice: price, qty: filledQty,
    leverage, marginMode: s.margin_mode, marginUsdt: sized.cost, tpPrice: tpPrice == null ? null : Number(tpPrice),
    slPrice: Number(slPrice), atr: signal.atr, confidence: signal.confidence,
    agreement: signal.agreement, strategies: signal.strategies?.map((x) => x.name) || [],
    reasoning: aiVerdict?.reasoning || risk.explain,
  });

  // resolve the exchange positionId (it appears right after the fill)
  let positionId = null;
  for (let i = 0; i < 6 && !positionId; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const ps = await bitunix.getPendingPositions({ symbol });
      const match = (ps || []).find((p) => p.side === (isLong ? 'LONG' : 'SHORT'));
      if (match) positionId = match.positionId;
    } catch {}
  }
  if (positionId) await attachPositionId(tradeId, positionId);

  // ---- method 2: partial TP ladder ---------------------------------------
  // The entry order already carries a whole-position TP/SL. When the settings
  // ask for PARTIAL we additionally lay a scale-out ladder over it, so profit
  // is banked in stages while a runner stays on for the rest of the move. The
  // stop is deliberately NOT laddered: scaling out of a loser is just being
  // wrong more slowly.
  let ladder = null;
  if (positionId && entryMethod() === 'PARTIAL') {
    try {
      ladder = await applyPartialTpSl({
        symbol, positionId, side: signal.side, entry: price, qty: filledQty,
        slDist: risk.slDist, ladder: s.partial_tp_ladder,
        liqPrice: risk.liqPrice,
      });
      if (ladder.ok) {
        log.info(`${symbol} partial ladder: ${ladder.placed.map((x) => `${x.share}%@${x.r}R`).join(' · ')}`
          + (ladder.runnerQty ? ` · runner ${ladder.runnerQty}` : ''));
      }
      for (const sk of ladder.skipped || []) log.warn(`${symbol} ladder ${sk.share}%@${sk.r}R skipped: ${sk.reason}`);
      await logEvent('partial_ladder', { symbol, placed: ladder.placed, skipped: ladder.skipped }, symbol);
    } catch (e) {
      log.warn(`${symbol} partial ladder failed: ${e.message}`);
    }
  }

  await setCooldown(symbol, Number(s.cooldown_min), 'opened position');
  await logEvent('position_opened', {
    symbol, side: signal.side, qty, price, marginUsdt, leverage,
    tpPrice, slPrice, rr: risk.rr, confidence: signal.confidence,
    agreement: signal.agreement, orderId: res?.orderId, positionId,
  }, symbol);

  return {
    ok: true, tradeId, positionId, orderId: res?.orderId, clientId,
    symbol, side: signal.side, qty: filledQty, price, leverage,
    marginUsdt: sized.cost, nominalUsdt: sized.nominal, orderUnit: unit,
    tpPrice: tpPrice == null ? null : Number(tpPrice), slPrice: Number(slPrice), risk, ladder,
  };
}

/** Close a position at market (flash close). */
export async function closePosition(positionId, reason = 'manual') {
  try {
    const res = await bitunix.flashClosePosition(positionId);
    await logEvent('position_closed', { positionId, reason });
    return { ok: true, res };
  } catch (e) {
    await logEvent('close_failed', { positionId, reason, error: e.message });
    return { ok: false, reason: e.message };
  }
}

/** Close everything (optionally one symbol). */
export async function closeAll(symbol = null) {
  try {
    const res = await bitunix.closeAllPositions(symbol ? { symbol } : {});
    await logEvent('close_all', { symbol });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Update the position-level TP/SL (place if missing, modify if present). */
/**
 * The furthest-advanced stop we have successfully written for each position.
 *
 * A stop is a ratchet: it may tighten toward profit, never loosen back toward
 * the entry. Every path that writes one (entry, the naked-position rescue, the
 * trailing engine) goes through here, so the rule is enforced in one place
 * rather than trusted to each caller — the QNTUSDT short lost its locked-in
 * profit precisely because the rescue path did not know the trailing engine
 * had already moved the stop.
 */
const bestStop = new Map();     // positionId -> { side, stop }

export function forgetStop(positionId) { bestStop.delete(String(positionId)); }
export function knownStop(positionId) { return bestStop.get(String(positionId))?.stop ?? null; }

/**
 * Forget every remembered stop.
 *
 * forgetStop(positionId) is the runtime path — it runs when a position is booked
 * closed, which is the only time this map should lose an entry on its own.
 * There was no way to clear it wholesale, so the ratchet leaked across test
 * scenarios: one scenario's locked-in stop silently vetoed the next scenario's
 * write, and the test then "passed" for the wrong reason.
 *
 * Exported for tests only. Nothing in the running system should call it.
 */
export function resetStopMemory() { bestStop.clear(); }

/**
 * Read the position-level TP/SL row back from the exchange.
 *
 * `get_pending_tpsl_orders` can return more than one row for a symbol: the
 * whole-position order plus any partial ladder rungs (those carry tpQty/slQty).
 * Bluntly taking row 0 means "the current stop" can be read off a partial rung,
 * so every read here picks the whole-position row for the requested position
 * and only falls back when there is nothing better.
 */
export async function readPositionTpSl({ symbol, positionId, side = null }) {
  let rows;
  try {
    // NO `side` filter: positionId is already exact, and the bot's side is
    // LONG/SHORT while the API speaks BUY/SELL. Passing it made the read-back
    // come up empty -> "exchange still shows no stop" and a bogus place_order.
    rows = await bitunix.getPendingTpSlOrders({ symbol, positionId });
  } catch (e) {
    log.warn(`${symbol}: cannot read back TP/SL (${e.message})`);
    return null;
  }

  const list = Array.isArray(rows) ? rows : (rows?.orderList || []);
  const forPos = list.filter(
    (r) => r && (positionId == null || String(r.positionId) === String(positionId)),
  );
  const pool = forPos.length ? forPos : list;
  const withStop = pool.filter((r) => r && r.slPrice != null);
  // With several rows (order-attached SL + position SL + rungs) the stop that
  // actually protects is the MOST protective one, not whichever came first.
  // Without a side we cannot rank them, so fall back to the whole-position row.
  const row = side
    ? mostProtectiveStopRow(withStop, side)
    : (withStop.find((r) => r.tpQty == null && r.slQty == null) || withStop[0] || null);
  if (!row) return null;

  return {
    slPrice: Number(row.slPrice),
    tpPrice: row.tpPrice != null ? Number(row.tpPrice) : null,
    row,
  };
}

/**
 * Did the stop we just asked for actually land on the exchange?
 *
 * `modify_order` resolving with code 0 is NOT proof the order changed — the
 * read-back is the only proof. Retried because the pending-orders view can lag
 * the write by a moment.
 */
async function verifyStopApplied({ symbol, positionId, side, want, tries = 3 }) {
  let current = null;
  for (let i = 0; i < tries; i++) {
    current = await readPositionTpSl({ symbol, positionId, side });
    if (current) {
      // quotePrecision can differ from what we sent by a hair; a genuine no-op
      // leaves the OLD stop far away, so a loose band is safe here.
      const tol = Math.max(Math.abs(want) * 1e-4, 1e-9);
      if (Math.abs(current.slPrice - want) <= tol) return { ok: true, current };
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 350));
  }
  return { ok: false, current };
}

export async function upsertPositionTpSl({ symbol, positionId, tpPrice, slPrice, side = null, entry = null }) {
  // ---- ratchet guard --------------------------------------------------
  if (slPrice != null && side) {
    const key = String(positionId);
    const prev = bestStop.get(key);
    if (prev && prev.side === side) {
      const loosening = side === 'LONG' ? slPrice < prev.stop : slPrice > prev.stop;
      if (loosening) {
        log.warn(`${symbol}: refusing to move the stop backwards `
          + `(${prev.stop} -> ${slPrice} on a ${side}); keeping ${prev.stop}`);
        slPrice = prev.stop;
      }
    }
  }

  const body = { symbol, positionId };
  if (tpPrice != null) body.tpPrice = await bitunix.roundPrice(symbol, tpPrice);
  if (slPrice != null) body.slPrice = await bitunix.roundPrice(symbol, slPrice);
  body.tpStopType = 'MARK_PRICE';
  body.slStopType = 'MARK_PRICE';

  // NOT named `remember`: that identifier is imported from ../db/index.js at
  // the top of this file, and shadowing it inside this function meant any
  // future db.remember call added here would silently log a trade outcome
  // instead of writing a memory.
  const noted = (mode, res) => {
    if (slPrice != null && side) bestStop.set(String(positionId), { side, stop: Number(body.slPrice) });
    return { ok: true, res, mode, slPrice: Number(body.slPrice), tpPrice: body.tpPrice ? Number(body.tpPrice) : null };
  };

  const wanted = slPrice != null ? Number(body.slPrice) : null;

  // Resolve the write, then PROVE it. Recording the stop in bestStop — and
  // letting the caller record it in its own ratchet — off a write that never
  // reached the book is what made this look like a working trailing stop: the
  // bot believed the stop was locked at breakeven, the ratchet then refused to
  // loosen it, and every later guard pass saw "nothing to improve" and returned
  // an empty action list while the position kept its original wide stop.
  const finish = async (mode, res) => {
    if (wanted == null) return noted(mode, res);   // TP-only edit: nothing to verify
    const v = await verifyStopApplied({ symbol, positionId, side, want: wanted });
    if (v.ok) return noted(mode, res);

    const seen = v.current?.slPrice ?? null;
    log.error(
      `${symbol} ${side || ''} ${positionId}: exchange accepted ${mode} but the stop is still `
      + `${seen ?? 'unset'} — asked for ${wanted}. Not recording it as moved.`,
    );
    await logEvent('tpsl_write_unverified', {
      symbol, positionId, side, mode, wanted, exchangeSl: seen,
    }, symbol);
    return {
      ok: false,
      mode,
      reason: `stop did not take effect: asked ${wanted}, exchange still shows ${seen ?? 'no stop'}`,
      slPrice: wanted,
      exchangeSl: seen,
    };
  };

  try {
    const existing = await bitunix.getPendingTpSlOrders({ symbol, positionId });
    const rows = (Array.isArray(existing) ? existing : (existing?.orderList || []))
      .filter((r) => r && String(r.positionId) === String(positionId));

    if (!rows.length) {
      return await finish('placed', await bitunix.placePositionTpSl(body));
    }

    // 1) position-level modify (works when the stop was made by position/place_order)
    const first = await finish('modified', await bitunix.modifyPositionTpSl(body));
    if (first.ok || wanted == null) return first;

    // 2) The entry order carries its SL attached (placeOrder slPrice=...). That
    //    row is an ORDER-level tp/sl with its own id; position/modify_order
    //    answers code 0 for it and changes nothing. Modify it by orderId.
    const row = rows.find((r) => r.slPrice != null) || rows[0];
    const id = row.id ?? row.orderId;
    const qty = row.slQty ?? row.tpQty ?? await positionQtyOf(symbol, positionId);
    if (id != null && qty != null) {
      try {
        const mbody = {
          orderId: String(id), symbol, positionId: String(positionId),
          slPrice: body.slPrice, slStopType: 'MARK_PRICE', slOrderType: 'MARKET', slQty: String(qty),
        };
        const keepTp = body.tpPrice ?? row.tpPrice;
        if (keepTp != null) {
          Object.assign(mbody, {
            tpPrice: String(keepTp), tpStopType: 'MARK_PRICE', tpOrderType: 'MARKET',
            tpQty: String(row.tpQty ?? qty),
          });
        }
        const second = await finish('modified-by-orderId', await bitunix.modifyTpSlOrder(mbody));
        if (second.ok) return second;
      } catch (e) { log.warn(`${symbol}: modify_order by id failed: ${e.message}`); }
    }

    // 3) Last resort: ADD a new full-size stop next to the old one. Never cancel
    //    the old stop first — a failed swap would leave the position naked.
    if (qty != null) {
      try {
        const third = await finish('added-order-stop', await bitunix.placeTpSlOrder({
          symbol, positionId: String(positionId),
          slPrice: body.slPrice, slStopType: 'MARK_PRICE', slOrderType: 'MARKET', slQty: String(qty),
        }));
        if (third.ok) return third;
      } catch (e) { log.warn(`${symbol}: add stop failed: ${e.message}`); }
    }
    return first;   // unverified result; manager arms the software stop
  } catch (e) {
    // duplicate tp/sl -> fall back to modify
    try {
      return await finish('modified-fallback', await bitunix.modifyPositionTpSl(body));
    } catch (e2) {
      return { ok: false, reason: `${e.message} | ${e2.message}` };
    }
  }
}

async function positionQtyOf(symbol, positionId) {
  try {
    const ps = await bitunix.getPendingPositions({ symbol });
    const p = (Array.isArray(ps) ? ps : []).find((x) => String(x.positionId) === String(positionId));
    return p ? p.qty : null;
  } catch { return null; }
}

/** Reversal: flatten the current side and immediately open the opposite one. */
export async function reverse(position, signal, aiVerdict = null) {
  const closed = await closePosition(position.positionId, 'reversal');
  if (!closed.ok) return { ok: false, reason: `close failed: ${closed.reason}` };
  await new Promise((r) => setTimeout(r, 1200));
  const opened = await openFromSignal(signal, { aiVerdict });
  await logEvent('reversal', {
    symbol: position.symbol, from: position.side, to: signal.side,
    confidence: signal.confidence, ok: opened.ok,
  }, position.symbol);
  return opened;
}
