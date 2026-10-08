/**
 * Exercise the REAL /calc command, driven through the REAL message router in
 * src/telegram/commands.js.
 *
 * The handler's collaborators are the real ones — real sizeOrder(), real
 * describeUnits(), real MarkdownV2 formatters (mdt/bold/italic/usd/fmtNum) —
 * so what this covers is the two things the other suites do not:
 *
 *   1. the argument parser, which must accept leverage and symbol in EITHER
 *      order (the usage text and the parser used to disagree), as split by the
 *      router from a raw "/calc 0.5 QTY 10 BTCUSDT" message
 *   2. the rendered Telegram output, which must be valid MarkdownV2
 *
 * The seams are deliberately minimal:
 *   - `bot` is injected through createCommandHandler's ctx, so replies are
 *     captured in-process. Nothing is sent and no Telegram token is needed.
 *   - `bitunix.getTickers` is stubbed for a fixed price, `pairInfo` for a fixed
 *     precision. `bitunix` is a singleton instance so this is safe; `db` is an
 *     ES module namespace and is read-only, so it is NOT stubbed — the
 *     default-leverage case reads whatever the real settings layer returns.
 *
 * validateMarkdownV2() is implemented here rather than imported: the codebase
 * claims its output was checked against a strict reimplementation of Telegram's
 * entity parser, but no such function ships in src/. A test asserting against a
 * missing helper would pass vacuously.
 */

/** Everything a backslash may introduce. */
const ESCAPABLE = /[_*[\]()~`>#+\-=|{}.!\\]/;
/**
 * Of those, the ones that are FORMATTING DELIMITERS rather than literals.
 * `*bold*`, `_italic_`, `` `code` `` and `[link](url)` are all legal with these
 * unescaped — they only have to balance. The rest must always be escaped.
 */
const DELIMS = /[*_`[\]()]/;

/**
 * Strict MarkdownV2 validator, matching the Bot API's rules:
 *  - every special outside code must be backslash-escaped
 *  - a backslash may only introduce an escapable character
 *  - *, _, [, ], ( ) must be balanced
 *  - code spans and fences carry no entities, so they are exempt
 *
 * @returns {string|null} null when valid, else why it is not.
 */
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
      if (next === undefined) return `trailing backslash`;
      if (!ESCAPABLE.test(next)) return `escapes a non-escapable character: \\${next}`;
      i++;
      continue;
    }

    if (ch === '[') open['[']++;
    if (ch === ']') open[']']--;
    if (ch === '(') open['(']++;
    if (ch === ')') open[')']--;
    if (ch === '*') open['*']++;
    if (ch === '_') open['_']++;

    // Delimiters are legal unescaped (they ARE the formatting); every other
    // literal must always carry a backslash.
    if (ESCAPABLE.test(ch) && !DELIMS.test(ch)) {
      return `unescaped literal ${JSON.stringify(ch)} at ${i}: ${JSON.stringify(src.slice(Math.max(0, i - 40), i + 40))}`;
    }
  }

  // Brackets must net to zero; emphasis must be EVEN. `*bold*` contributes two
  // asterisks, not zero, so a net-zero test would reject every valid bold run.
  for (const k of ['[', ']', '(', ')']) {
    if (open[k] !== 0) return `unbalanced "${k}" (${open[k] > 0 ? 'unclosed' : 'stray close'})`;
  }
  if (open['*'] % 2 !== 0) return `unbalanced "*" (${open['*']} unmatched)`;
  if (open['_'] % 2 !== 0) return `unbalanced "_" (${open['_']} unmatched)`;
  return null;
}

// ---------------------------------------------------------------- the harness
let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const includes = (hay, needle) => String(hay).includes(needle);

/** Assert valid MarkdownV2, reporting the reason rather than just a boolean. */
const md2 = (t) => {
  const why = validateMarkdownV2(t);
  return assert(why === null, why === null
    ? `valid MarkdownV2 — "${String(t).split('\n')[0].slice(0, 60)}"`
    : `INVALID MarkdownV2 — ${why}`);
};

const CHAT = 12345;

async function test() {
  console.log('=== /calc command, through the real router (real commands.js) ===\n');

  // A bot that captures instead of sending.
  const sent = [];
  const fakeBot = {
    sendMessage: (chatId, text) => { sent.push({ chatId, text }); return []; },
    sendTyping: async () => {},
  };

  const bitunix = (await import('../src/exchange/bitunix.js')).default;
  const savedTickers = bitunix.getTickers;
  const savedPairInfo = bitunix.pairInfo;

  const PRICE = 10000;
  const setPrice = (px) => { bitunix.getTickers = async () => [{ symbol: 'BTCUSDT', markPrice: String(px) }]; };
  setPrice(PRICE);
  bitunix.pairInfo = async () => ({ basePrecision: 4, minTradeVolume: 0.001, quotePrecision: 2 });

  const { createCommandHandler } = await import('../src/telegram/commands.js');
  const handle = createCommandHandler({ bot: fakeBot, orchestrator: null });

  /** Send a raw "/calc ..." message and return the last reply's text. */
  const run = async (text) => {
    sent.length = 0;
    await handle({ chat: { id: CHAT }, text });
    return String(sent.at(-1)?.text ?? '');
  };

  // The label goes through bold(), so it arrives as *Qty \(base coin\)* and the
  // value as an escaped number. Unescape before comparing.
  const unescape = (s) => s.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
  const qtyOf = (txt) => {
    const m = /Qty \\\(base coin\\\)\*:([^\n]*)/.exec(txt);
    return m ? unescape(m[1].trim()) : null;
  };

  console.log('No arguments prints the explanation, not an error');
  let t = await run('/calc');
  assert(includes(t, 'Order Unit Calculator'), 'renders the help header');
  assert(includes(t, 'Usage: /calc'), 'shows the usage line');
  assert(includes(t, 'Examples:'), 'shows examples');
  assert(!t.includes('**'), 'no malformed double-asterisk bold');
  md2(t);

  console.log('\nLeverage and symbol parse in either order');
  // 0.5 BTC at 10x on a 10000 pair = 1000 nominal, 100 margin.
  const a = await run('/calc 0.5 QTY 10 BTCUSDT');
  const b = await run('/calc 0.5 QTY BTCUSDT 10');
  assert(includes(a, 'Leverage: 10x'), 'symbol-then-leverage got leverage 10');
  assert(includes(a, 'BTCUSDT'), 'symbol-then-leverage got the symbol');
  assert(b === a, 'leverage-then-symbol produces byte-identical output');
  md2(a); md2(b);

  console.log('\nEach unit converts to the same position');
  const seen = [];
  for (const cmd of ['/calc 1000 NOMINAL 10 BTCUSDT', '/calc 100 COST 10 BTCUSDT', '/calc 0.1 QTY 10 BTCUSDT']) {
    const txt = await run(cmd);
    seen.push(qtyOf(txt));
    md2(txt);
  }
  assert(seen[0] !== null && seen.every((q) => q === seen[0]),
    `all three units give the same qty: ${seen.join(' / ')}`);

  console.log('\nLeverage and symbol are optional');
  const dflt = await run('/calc 1000 NOMINAL');
  const lev = /Leverage: (\d+)x/.exec(dflt);
  assert(lev !== null, `a default leverage is applied (${lev?.[1]}x)`);
  assert(includes(dflt, 'BTCUSDT'), 'defaults to BTCUSDT when no symbol is given');
  md2(dflt);

  console.log('\nThe @botname suffix is stripped, as in real Telegram');
  const atForm = await run('/calc@aria_bot 100 COST 10 BTCUSDT');
  const plainForm = await run('/calc 100 COST 10 BTCUSDT');
  assert(atForm === plainForm, '/calc@name behaves exactly like /calc');

  console.log('\nRounding is reported honestly, not hidden');
  // 100 USDT of margin at 10x on a 50123.45 pair truncates to 0.0199.
  setPrice(50123.45);
  const rough = await run('/calc 100 COST 10 BTCUSDT');
  assert(qtyOf(rough) === '0.0199', `qty truncated to 0.0199 (raw would be 0.01993...), got ${qtyOf(rough)}`);
  assert(includes(rough, 'Requested nominal'), 'the un-rounded request is shown alongside');
  md2(rough);
  setPrice(PRICE);

  console.log('\nBad input is rejected cleanly, not by crashing');
  for (const [cmd, why] of [
    ['/calc 0 COST', 'zero amount'],
    ['/calc -5 COST', 'negative amount'],
    ['/calc abc COST', 'non-numeric amount'],
    ['/calc 100 BANANA', 'unknown unit'],
    ['/calc 100', 'missing unit'],
  ]) {
    const txt = await run(cmd);
    assert(!txt.includes('/calc failed'),
      `${why} is handled, not thrown (got "${txt.slice(0, 50)}")`);
    assert(txt.startsWith('❌'), `${why} replies with an error`);
    md2(txt);
  }

  console.log('\nA dead ticker reports the failure instead of dividing by zero');
  bitunix.getTickers = async () => { throw new Error('exchange unreachable'); };
  const dead = await run('/calc 100 COST');
  assert(!dead.includes('/calc failed'), 'a rejected ticker fetch is handled, not thrown');
  assert(dead.startsWith('❌'), 'price-fetch failure is reported');
  assert(includes(dead, 'exchange unreachable'), 'the underlying reason survives');
  md2(dead);

  console.log('\nA ticker with no usable price is caught too');
  bitunix.getTickers = async () => [{ symbol: 'BTCUSDT' }];
  const noPx = await run('/calc 100 COST');
  assert(!noPx.includes('/calc failed'), 'a price-less ticker is handled, not thrown');
  assert(noPx.startsWith('❌'), 'missing markPrice is rejected');
  md2(noPx);

  bitunix.getTickers = savedTickers;
  bitunix.pairInfo = savedPairInfo;

  console.log(`\npassed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

test().catch((e) => { console.error(e); process.exit(1); });
