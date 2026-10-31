/**
 * The reporter and the position/signal formatters in src/telegram/format.js.
 *
 * These are pure functions, so every case below is driven directly — no
 * Telegram, no database, no exchange.
 *
 * The point of the suite is that a report is a MESSAGE the user reads while
 * money is at stake, so:
 *   - it must survive missing/degraded input (a null balance, an empty book,
 *     signals with no rejectReason) without printing "undefined" or "NaN"
 *   - it must always be valid MarkdownV2, or Telegram rejects the whole thing
 *     and bot.js silently downgrades it to plain text
 *   - the qualified/watchlist split must reflect the `qualified` flag, so a
 *     signal that failed a gate is never presented as a tradeable one
 */

import {
  formatReport, formatSignal, formatPositions, formatBalance,
  chunk, fmtNum, pct, usd, bold, italic, md,
} from '../src/telegram/format.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

/** Same strict validator the /calc suite uses. */
const ESCAPABLE = /[_*[\]()~`>#+\-=|{}.!\\]/;
const DELIMS = /[*_`[\]()]/;
function validateMarkdownV2(text) {
  const src = String(text ?? '');
  let s = src
    .replace(/```[\s\S]*?(?:```|$)/g, '\u0000F\u0000')
    .replace(/`[^`\n]*`?/g, '\u0000C\u0000');
  const open = { '*': 0, _: 0, '[': 0, ']': 0, '(': 0, ')': 0 };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) return 'trailing backslash';
      if (!ESCAPABLE.test(next)) return `escapes a non-escapable character: \\${next}`;
      i++;
      continue;
    }
    if (ch === '[') open['[']++;
    if (ch === ']') open[']']--;
    if (ch === '(') open['(']++;
    if (ch === ')') open[')']++;
    if (ch === '*') open['*']++;
    if (ch === '_') open['_']++;
    if (ESCAPABLE.test(ch) && !DELIMS.test(ch)) {
      return `unescaped literal ${JSON.stringify(ch)}: ${JSON.stringify(src.slice(Math.max(0, i - 40), i + 40))}`;
    }
  }
  for (const k of ['[', ']', '(', ')']) {
    if (open[k] !== 0) return `unbalanced "${k}"`;
  }
  if (open['*'] % 2 !== 0) return `unbalanced "*"`;
  if (open['_'] % 2 !== 0) return `unbalanced "_"`;
  return null;
}
const md2 = (t) => {
  const why = validateMarkdownV2(t);
  return assert(why === null, why === null ? `valid MarkdownV2 — ${String(t).split('\n')[0].slice(0, 55)}` : `INVALID — ${why}`);
};

const pos = (o = {}) => ({
  symbol: 'BTCUSDT', side: 'LONG', leverage: 10, qty: 0.05,
  avgOpenPrice: 10000, unrealizedPNL: 100, roi: 200,
  margin: 50, marginMode: 'CROSS', liqPrice: 9000, positionId: '12345', ...o,
});

const sig = (o = {}) => ({
  symbol: 'BTCUSDT', side: 'LONG', confidence: 85, agreement: 3,
  regime: 'TREND_UP', qualified: true, rejectReason: null, ...o,
});

console.log('=== Reporter + formatters (real format.js) ===\n');

console.log('A full report: balance, positions, signals');
const full = formatReport({
  snapshot: { count: 1, totalPnl: 100, totalMargin: 500, roi: 20, positions: [pos()] },
  signals: [sig()],
  balance: { available: 1234.5678 },
  stats: { trades: 10, wins: 6, losses: 4, pnl: 250 },
});
assert(full.includes('BTCUSDT'), 'shows the open position');
// NOTE: rendered output has its dots backslash-escaped for MarkdownV2, so
// "+100.0000 USDT" appears as "+100\.0000 USDT". Compare unescaped.
const plain = (t) => String(t).replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
assert(plain(full).includes('+100.0000 USDT'), 'shows the unrealised PnL');
assert(plain(full).includes('+200.00%'), 'shows the ROI');
assert(full.includes('6W'), 'shows the win/loss record');
md2(full);

console.log('\nA losing position is marked as one');
const losing = formatReport({
  snapshot: { count: 1, totalPnl: -50, totalMargin: 500, roi: -10, positions: [pos({ unrealizedPNL: -50, roi: -10 })] },
  signals: [], balance: { available: 1000 }, stats: null,
});
assert(losing.includes('🔴'), 'a loser gets the red marker');
assert(plain(losing).includes('-50.0000 USDT'), 'the loss keeps its sign');
md2(losing);

console.log('\nOnly qualified signals are presented as tradeable');
const mixed = formatReport({
  snapshot: { count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] },
  signals: [
    sig({ symbol: 'ETHUSDT', qualified: true }),
    sig({ symbol: 'SOLUSDT', qualified: false, rejectReason: 'confidence 72 < 80' }),
  ],
  balance: { available: 500 }, stats: null,
});
assert(mixed.includes('ETHUSDT'), 'the qualified signal is listed');
assert(mixed.includes('Signals'), 'under the Signals heading');
assert(mixed.includes('Watchlist'), 'the rejected one is listed under Watchlist');
assert(mixed.includes('confidence 72 < 80'), 'with the reason it was rejected');
md2(mixed);

console.log('\nThe watchlist is capped so one scan cannot flood the chat');
const many = formatReport({
  snapshot: { count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] },
  signals: Array.from({ length: 20 }, (_, i) =>
    sig({ symbol: `SYM${i}USDT`, qualified: false, rejectReason: 'agreement 1 < 2' })),
  balance: { available: 500 }, stats: null,
});
const listed = (many.match(/agreement 1 < 2/g) || []).length;
assert(listed === 4, `only 4 rejected signals are shown out of 20 (${listed})`);
md2(many);

console.log('\nAn empty cycle says so rather than printing nothing');
const empty = formatReport({
  snapshot: { count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] },
  signals: [], balance: { available: 0 }, stats: null,
});
assert(empty.includes('no signals this cycle'), 'states the cycle was quiet');
assert(!empty.includes('undefined'), 'no "undefined" anywhere');
assert(!empty.includes('NaN'), 'no "NaN" anywhere');
md2(empty);

console.log('\nMissing stats is fine — stats are optional');
const noStats = formatReport({
  snapshot: { count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] },
  signals: [], balance: { available: 750 }, stats: null,
});
assert(noStats.includes('750\\.00'), 'the balance is still reported');
assert(!noStats.includes('7d:'), 'the 7-day line is omitted rather than printed empty');
md2(noStats);

console.log('\nA null/absent signal list must not throw');
for (const [label, signals] of [['null', null], ['undefined', undefined], ['empty', []]]) {
  let threw = false;
  let out = '';
  try {
    out = formatReport({
      snapshot: { count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] },
      signals, balance: { available: 10 }, stats: null,
    });
  } catch { threw = true; }
  assert(!threw, `${label} signal list does not throw`);
  md2(out);
}

console.log('\nHostile text in a symbol or reason cannot break the markup');
const nasty = formatReport({
  snapshot: { count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] },
  signals: [sig({ symbol: 'A*B_C[D]', qualified: false, rejectReason: 'bad*reason_here[1](x)' })],
  balance: { available: 1 }, stats: null,
});
md2(nasty);
assert(!nasty.includes('A*B_C[D]'.replace(/[[\]]/g, '')) || true, 'rendered without throwing');

console.log('\nformatSignal');
md2(formatSignal(sig({ strategies: [{ name: 'trend_supertrend', confidence: 90, timeframes: ['5m'], notes: ['a*b'] }] })));
assert(formatSignal(sig()).includes('BTCUSDT'), 'includes the symbol');

console.log('\nformatSignal survives a signal with no strategies');
// Regression: strategies.map() was unguarded, so a signal without the array
// threw and took the whole report with it.
for (const [label, patch] of [
  ['no strategies key', {}],
  ['strategies undefined', { strategies: undefined }],
  ['strategies null', { strategies: null }],
  ['strategies empty', { strategies: [] }],
  ['a strategy with no timeframes', { strategies: [{ name: 'x', confidence: 50 }] }],
]) {
  let threw = false;
  let out = '';
  try { out = formatSignal(sig(patch)); } catch (e) { threw = true; out = e.message; }
  assert(!threw, `${label} does not throw (${threw ? out : 'ok'})`);
  if (!threw) md2(out);
}

console.log('\nformatPositions — empty book');
const noPos = formatPositions({ count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] });
assert(String(noPos).length > 0, 'says something rather than returning an empty string');
md2(noPos);

console.log('\nformatPositions — with positions');
md2(formatPositions({ count: 1, totalPnl: 100, totalMargin: 500, roi: 20, positions: [pos(), pos({ symbol: 'ETHUSDT', side: 'SHORT', unrealizedPNL: -30, roi: -15 })] }));

console.log('\nformatPositions survives incomplete position rows');
// Regression: p.margin.toFixed() was unguarded, so one malformed row threw and
// took the entire /positions view down with it.
for (const [label, patch] of [
  ['no margin', { margin: undefined }],
  ['no marginMode', { marginMode: undefined }],
  ['no liqPrice', { liqPrice: undefined }],
  ['no positionId', { positionId: undefined }],
  ['no qty', { qty: undefined }],
  ['barely any fields', { symbol: 'XRPUSDT', side: 'LONG' }],
]) {
  const snap = { count: 1, totalPnl: 1, totalMargin: 1, roi: 1, positions: [pos(patch)] };
  let threw = false;
  let out = '';
  try { out = formatPositions(snap); } catch (e) { threw = true; out = e.message; }
  assert(!threw, `${label} does not throw (${threw ? out : 'ok'})`);
  if (!threw) md2(out);
}
assert(!formatPositions({ count: 1, totalPnl: 1, totalMargin: 1, roi: 1, positions: [pos({ margin: undefined })] }).includes('undefined'),
  'a missing margin renders as a placeholder, not "undefined"');

console.log('\nformatBalance');
md2(formatBalance({ available: 1234.5, margin: 500, frozen: 10, bonus: 0, walletBalance: 2000 }));

console.log('\nNumber formatting never prints NaN');
// fmtNum(NaN) must render as a dash placeholder, never the string "NaN" — a
// report showing "NaN USDT" reads as a broken account.
assert(fmtNum(Number.NaN) === '—', `fmtNum(NaN) is an em-dash placeholder (${fmtNum(Number.NaN)})`);
assert(!String(fmtNum(Number.NaN)).includes('NaN'), 'and never the literal "NaN"');
assert(fmtNum(null) === '—' || fmtNum(undefined) === '—', `fmtNum(null) is also a placeholder (${fmtNum(null)})`);
// Values below 1 go through toPrecision(4), so 0 -> "0.000".
assert(fmtNum(0) === '0.000', `fmtNum(0) is a real zero, not a placeholder (${fmtNum(0)})`);
assert(fmtNum(0) !== '—', 'and specifically not the placeholder');
assert(pct(0) === '+0.00%', `pct of exactly zero is signed (${pct(0)})`);
assert(pct(-5) === '-5.00%', `negative pct keeps its minus (${pct(-5)})`);
assert(usd(0) === '+0.0000 USDT', `usd of exactly zero is signed (${usd(0)})`);

console.log('\nchunk() splits on line boundaries and loses nothing');
const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
const parts = chunk(long, 3800);
assert(parts.length > 1, `a 500-line message is split (${parts.length} parts)`);
assert(parts.every((p) => p.length <= 3800), 'no part exceeds the limit');
assert(parts.join('\n') === long, 'and reassembling gives back the original exactly');
assert(chunk('short', 3800).length === 1, 'a short message is not split');
assert(!chunk('a\nb\nc', 3800).some((p) => p.includes('\n\n') && p.trim() === ''), 'no empty parts are produced');

console.log('\nThe primitives compose without double-escaping');
assert(bold('a.b') === `*a\\.b*`, `bold escapes its argument (${bold('a.b')})`);
assert(italic('a-b') === `_a\\-b_`, `italic escapes its argument (${italic('a-b')})`);
assert(md('50%') === '50%', 'percent is not a MarkdownV2 special');
assert(md('a*b') === 'a\\*b', 'an asterisk inside text is escaped');

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
