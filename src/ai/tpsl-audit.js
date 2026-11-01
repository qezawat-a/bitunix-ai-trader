import bitunix from '../exchange/bitunix.js';
import { q, settings } from '../db/index.js';
import { parseLadder } from '../settings-schema.js';

/**
 * What did the exchange actually end up holding for a position, compared with
 * what the ladder setting says it should hold? Read-only.
 *
 * Rungs sit at entry +/- slDist * R. On a low-priced coin the price tick can be
 * as large as the stop distance (0.00328 with 5 decimals: one tick = 0.3%), so
 * several R levels round to the SAME price and the exchange shows one merged or
 * one missing row. expected[] makes that visible rung by rung.
 */
export function auditTpSl({ side, qty, entry, slDist, steps, rows, round }) {
  const dir = side === 'LONG' ? 1 : -1;
  const expected = steps.map((st) => ({
    share: st.share, r: st.r,
    price: round(Number(entry) + dir * slDist * st.r),
    qty: (Number(qty) * st.share) / 100,
  }));
  const flags = [];

  const prices = expected.map((x) => x.price);
  const dupPrices = prices.filter((p, i) => prices.indexOf(p) !== i);
  if (dupPrices.length) flags.push(`${new Set(dupPrices).size} ladder price(s) collide after rounding to the price tick (${[...new Set(dupPrices)].join(', ')}): rungs at different R land on the same price.`);

  const tpRows = rows.filter((r) => r.tpPrice != null);
  const seen = {};
  for (const r of tpRows) seen[Number(r.tpPrice)] = (seen[Number(r.tpPrice)] || 0) + 1;
  const dupRows = Object.entries(seen).filter(([, n]) => n > 1).map(([p]) => p);
  if (dupRows.length) flags.push(`Exchange holds more than one TP row at the same price: ${dupRows.join(', ')}.`);

  const missing = expected.filter((x) => !tpRows.some((r) => Math.abs(Number(r.tpPrice) - x.price) < 1e-12 + Math.abs(x.price) * 1e-9));
  if (missing.length) flags.push(`No TP row on the exchange for: ${missing.map((x) => `${x.share}%@${x.r}R (${x.price})`).join(', ')}.`);

  const tpQty = tpRows.reduce((a, r) => a + (Number(r.tpQty) || 0), 0);
  const wantQty = expected.reduce((a, x) => a + x.qty, 0);
  if (tpRows.length && Math.abs(tpQty - wantQty) / Math.max(1, wantQty) > 0.02) flags.push(`TP quantity on the exchange is ${tpQty} but the ladder expects about ${wantQty.toFixed(0)}.`);

  const slRows = rows.filter((r) => r.slPrice != null);
  const wholeStop = slRows.some((r) => r.slQty == null && r.tpQty == null);
  const slQty = Math.max(0, ...slRows.map((r) => Number(r.slQty) || 0));
  if (slRows.length && !wholeStop && slQty && slQty < Number(qty) * 0.98) flags.push(`The largest stop row covers ${slQty} of ${qty}: no whole-position stop is listed in these rows, so part of the position may have no stop here. Check the Positions tab TP/SL.`);
  if (!slRows.length) flags.push('No stop row is listed for this position.');

  return { expected, flags, tpRows: tpRows.length, slRows: slRows.length };
}

export async function auditSymbol(symbol) {
  const sym = String(symbol).toUpperCase();
  const [positions, rawRows, trade] = await Promise.all([
    bitunix.getPendingPositions({ symbol: sym }),
    bitunix.getPendingTpSlOrders({ symbol: sym }),
    q(`SELECT entry_price, sl_price, tp_price, qty, side FROM trades WHERE symbol=$1 AND status='OPEN' ORDER BY id DESC LIMIT 1`, [sym]).then((r) => r.rows[0]).catch(() => null),
  ]);
  const pos = (positions || [])[0];
  if (!pos) return { symbol: sym, open: false };
  const rows = (Array.isArray(rawRows) ? rawRows : (rawRows?.orderList || []))
    .filter((r) => r && String(r.positionId) === String(pos.positionId));
  const entry = Number(trade?.entry_price ?? pos.avgOpenPrice);
  const slDist = trade?.sl_price ? Math.abs(entry - Number(trade.sl_price)) : null;
  const steps = parseLadder(settings().partial_tp_ladder);
  const info = await bitunix.pairInfo(sym);
  const prec = Number(info?.quotePrecision ?? 8);
  const round = (p) => Number(Number(p).toFixed(prec));
  const audit = slDist ? auditTpSl({ side: pos.side, qty: Number(pos.qty), entry, slDist, steps, rows, round }) : { expected: [], flags: ['No open trade row with a planned stop was found, so the ladder cannot be reconstructed.'] };
  return {
    symbol: sym, open: true, side: pos.side, qty: Number(pos.qty), entry, plannedStopDistPct: slDist ? (slDist / entry) * 100 : null,
    priceTick: Math.pow(10, -prec), tickPctOfPrice: (Math.pow(10, -prec) / entry) * 100,
    ladderSetting: settings().partial_tp_ladder, tpslMethod: settings().tpsl_method,
    rows: rows.map((r) => ({ id: r.id ?? r.orderId, tpPrice: r.tpPrice, tpQty: r.tpQty, slPrice: r.slPrice, slQty: r.slQty })),
    ...audit,
  };
}
