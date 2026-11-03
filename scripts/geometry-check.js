#!/usr/bin/env node
/**
 * Does the stop/target geometry pay for itself?
 *
 *   node scripts/geometry-check.js [TP%] [SL%] [hours] [SYM1,SYM2,...]
 *   node scripts/geometry-check.js 1.35 0.91 16 ICNTUSDT,QUSDT
 *
 * For every 1-minute bar of the last `hours` on each symbol, treat the bar's
 * close as a hypothetical entry and walk forward: which barrier is touched
 * first, the take-profit or the stop? That fraction is the win rate the
 * geometry produces from a RANDOM entry — no strategy, no cleverness. It is
 * the number the bot has to beat, because break-even needs
 * (SL + round-trip fees) / (SL + TP) at best.
 *
 * Read-only: the public kline endpoint needs no API key and no account.
 */
const API = 'https://fapi.bitunix.com/api/v1/futures/market/kline';

const arg = (i, d) => {
  const v = process.argv[i + 2];
  return v === undefined || v === '' ? d : v;
};
const TP = Number(arg(0, 1.35));                     // % of price
const SL = Number(arg(1, 0.91));
const HOURS = Number(arg(2, 16));
const FEE = Number(arg(3, 0.12));
const SYMS = String(arg(4, 'BTCUSDT,ETHUSDT,SOLUSDT')).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
// Minutes a trade is allowed to live. The bot's own trades mostly end in 5-10
// minutes, so the fair question is "what does this geometry pay at THAT horizon".
let HORIZON = Number(arg(5, 120));

if (!(TP > 0) || !(SL > 0)) {
  console.error('usage: node scripts/geometry-check.js [TP%] [SL%] [hours] [FEE%] [SYM,SYM]');
  process.exit(1);
}

async function bars(symbol, pages) {
  let all = [];
  let end = Date.now();
  for (let p = 0; p < pages; p++) {
    const res = await fetch(`${API}?symbol=${symbol}&interval=1m&limit=200&endTime=${end}&type=MARK_PRICE`);
    const json = await res.json();
    const rows = (json.data || [])
      .map((k) => ({ time: Number(k.time), high: Number(k.high), low: Number(k.low), close: Number(k.close) }))
      .filter((c) => c.high > 0 && c.low > 0);
    if (!rows.length) break;
    all = rows.sort((a, b) => a.time - b.time).concat(all);
    end = all[0].time - 1;
  }
  // de-duplicate the page boundaries and keep it oldest-first
  return all.filter((c, i, a) => i === 0 || c.time !== a[i - 1].time).sort((a, b) => a.time - b.time);
}

/** Fraction of entries that reach `tp` before `sl`, both in % of the entry. */
export function firstTouch(candles, { tpPct, slPct, horizon = HORIZON }) {
  let win = 0, loss = 0, open = 0;
  for (let i = 0; i + 2 < candles.length; i++) {
    const entry = candles[i].close;
    if (!(entry > 0)) continue;
    let done = false;
    const last = Math.min(candles.length, i + 1 + horizon);
    for (let j = i + 1; j < last; j++) {
      // Pessimistic on a bar that touches both: the stop is counted first,
      // because that is the order an intrabar wick can hide.
      if (candles[j].low <= entry * (1 - slPct / 100)) { loss++; done = true; break; }
      if (candles[j].high >= entry * (1 + tpPct / 100)) { win++; done = true; break; }
    }
    if (!done) open++;
  }
  const decided = win + loss;
  return { win, loss, open, n: decided + open, pWin: decided ? win / decided : 0 };
}

async function main() {
  const pages = Math.max(1, Math.ceil((HOURS * 60) / 200));
  console.log(`geometry: TP +${TP}% / SL -${SL}% · round-trip fee ${FEE}% · horizon ${HORIZON} min · last ${HOURS}h of 1m bars\n`);
  console.log('symbol          bars   P(TP first) from a RANDOM entry');
  let tw = 0, tl = 0, tn = 0;
  for (const sym of SYMS) {
    let c;
    try { c = await bars(sym, pages); } catch (e) { console.log(`${sym.padEnd(14)}  skipped (${e.message})`); continue; }
    if (c.length < 50) { console.log(`${sym.padEnd(14)}  skipped (no history)`); continue; }
    const r = firstTouch(c, { tpPct: TP, slPct: SL });
    tw += r.win; tl += r.loss; tn += r.n;
    console.log(`${sym.padEnd(14)} ${String(r.n).padStart(5)}   ${((r.pWin) * 100).toFixed(0)}%`);
  }
  if (!(tw + tl)) { console.log('\nno data'); return; }
  const p = tw / (tw + tl);
  const be = (SL + FEE) / (SL + TP);       // break-even win rate including fees
  console.log(`\nALL             ${tn}   ${(p * 100).toFixed(0)}% hit the target before the stop`);
  console.log(`break-even needs ${(be * 100).toFixed(0)}% (stop ${SL}% + fees ${FEE}% against a ${TP}% target)`);
  console.log(p >= be
    ? 'the geometry itself is viable — any loss rate is then a question of entries and early exits.'
    : 'the geometry itself does NOT pay: even hitting it exactly as often as random price movement is a losing system.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
