/**
 * Telegram formatting helpers.
 *
 * THE BUG THIS FIXES:
 * the reference scanner sent MarkdownV2/Markdown text containing raw
 * `_`, `*`, `[`, `` ` `` coming from symbols, strategy names ("vwap_reversion",
 * "min_confidence") and JSON dumps. Telegram then rejected the whole message
 * with 400 "can't parse entities" and the export/report silently never arrived.
 *
 * Strategy here:
 *  - build messages in MarkdownV2
 *  - escape EVERY dynamic value with md()
 *  - hard-fail-safe: sendMessage retries as plain text if Telegram still
 *    complains, so a report is never lost
 */

// Every message that reports an agreement count has to know how many
// strategies could have voted. Hardcoding 6 turned every report into a lie the
// moment a strategy was added, and the scan loop crashed on the bare
// identifier because this module never imported it.
import { STRATEGY_COUNT } from '../strategies/index.js';

const MDV2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape a dynamic value for MarkdownV2. */
export const md = (v) => String(v ?? '').replace(MDV2_SPECIALS, '\\$&');

/** Escape only what breaks inside a code span. */
export const code = (v) => '`' + String(v ?? '').replace(/[`\\]/g, '\\$&') + '`';

export const bold = (v) => `*${md(v)}*`;
export const italic = (v) => `_${md(v)}_`;

/**
 * Template tag that escapes BOTH the static text and the interpolations.
 *
 * Escaping only the interpolations (what the reference scanner did) is not
 * enough: literal `(`, `)`, `/6`, `—`, `.` and `!` in the template itself are
 * also MarkdownV2 entities and produce the same 400 error. Everything inside
 * mdt`` is therefore treated as plain text; use bold()/italic() explicitly when
 * you want emphasis.
 */
export function mdt(strings, ...values) {
  return strings.reduce(
    (acc, s, i) => acc + md(s) + (i < values.length ? md(values[i]) : ''),
    '',
  );
}

/**
 * Convert free-form LLM markdown into SAFE MarkdownV2.
 *
 * The agent writes classic markdown (**bold**, *bold*, _italic_, `code`,
 * - bullets, ### headings). Sending that straight to Telegram is exactly what
 * breaks reports: stray `*`, `_`, `.`, `-`, `(` all count as entities.
 *
 * Here we: pull out code spans/blocks, escape everything else, then restore a
 * whitelist of *balanced* emphasis pairs and the code spans.
 */
export function agentText(input) {
  if (!input) return '';
  let text = String(input);

  // 1. stash code blocks and inline code
  const stash = [];
  const keep = (s) => { stash.push(s); return `\u0000${stash.length - 1}\u0000`; };
  text = text.replace(/```[\s\S]*?```/g, (m) => keep(m));
  text = text.replace(/`[^`\n]+`/g, (m) => keep(m));

  // 2. normalise headings and ** -> * before escaping
  text = text.replace(/^#{1,6}\s*(.+)$/gm, (_, t) => `\u0001${t.trim()}\u0001`); // heading -> bold
  text = text.replace(/\*\*([^\n*]+)\*\*/g, (_, t) => `\u0001${t}\u0001`);       // **bold** -> bold
  text = text.replace(/(?<![\w*])\*([^\n*]+)\*(?![\w*])/g, (_, t) => `\u0001${t}\u0001`);
  text = text.replace(/(?<![\w_])_([^\n_]+)_(?![\w_])/g, (_, t) => `\u0002${t}\u0002`);
  text = text.replace(/^\s*[-*+]\s+/gm, '\u0003 ');                              // bullets

  // 3. escape EVERYTHING
  text = md(text);

  // 4. restore the whitelisted markers
  text = text
    .replace(/\u0001/g, '*')
    .replace(/\u0002/g, '_')
    .replace(/\u0003/g, '•');

  // 5. restore code, escaping only what breaks inside it
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const raw = stash[Number(i)];
    if (raw.startsWith('```')) {
      const body = raw.slice(3, -3).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      return '```' + body + '```';
    }
    return '`' + raw.slice(1, -1).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
  });

  return text;
}

export function fmtNum(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(digits);
  return n.toPrecision(Math.max(4, digits));
}

export const pct = (v, d = 2) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
export const usd = (v, d = 4) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(d)} USDT`;

/** Split long text on line boundaries so nothing is truncated by Telegram's 4096 limit. */
export function chunk(text, size = 3800) {
  if (text.length <= size) return [text];
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size) { out.push(cur); cur = ''; }
    // a single monstrous line
    if (line.length > size) {
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
      continue;
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ messages

export function formatSignal(s) {
  const emoji = s.side === 'LONG' ? '🟩' : '🟥';
  const lines = [
    `${emoji} ${bold(`${s.symbol} ${s.side}`)}`,
    mdt`confidence ${s.confidence}%  ·  agreement ${s.agreement}/${STRATEGY_COUNT}  ·  regime ${s.regime} (HTF ${s.htfRegime || '—'})`,
    mdt`raw ${s.rawConfidence || s.confidence}% · scanned ${new Date().toLocaleTimeString('en', {hour12:false})}`,
    mdt`price ${fmtNum(s.price, 6)}  ·  ATR ${Number(s.atrPct || 0).toFixed(3)}%${s.funding != null ? `  ·  funding ${Number(s.funding).toFixed(4)}%` : ''}`,
    '',
    bold('Strategies'),
    // A signal can reach here with no strategies at all: consensus() returns
    // null before it can, but a hand-built or persisted row may not carry them,
    // and an unguarded .map took the whole report down with it.
    ...(s.strategies || []).map((x) => mdt`  • ${x.name} — ${x.confidence}% on ${(x.timeframes || []).join(', ')}`),
  ];
  if (s.opposite?.agreement) {
    lines.push(mdt`  ⚠ ${s.opposite.agreement} opposing (${s.opposite.side} @ ${s.opposite.confidence}%)`);
  }
  if (s.flags?.length) lines.push('', mdt`flags: ${s.flags.join('; ')}`);
  if (!s.qualified) lines.push('', mdt`⛔ not taken — ${s.rejectReason}`);
  return lines.join('\n');
}

export function formatFill(r) {
  return [
    `⚡ ${bold(`OPENED ${r.symbol} ${r.side}`)}`,
    mdt`entry ${fmtNum(r.price, 6)}  ·  qty ${r.qty}  ·  margin ${Number(r.marginUsdt).toFixed(2)} USDT  ·  ${r.leverage}x`,
    mdt`TP ${fmtNum(r.tpPrice, 6)}  ·  SL ${fmtNum(r.slPrice, 6)}  ·  ${r.risk.rr}R`,
    mdt`${r.risk.explain}`,
    r.positionId ? mdt`position ${r.positionId}` : '',
  ].filter(Boolean).join('\n');
}

export function formatPositions(snap) {
  if (!snap.count) return '📭 No open positions\\.';
  const head = [
    bold('Open positions'),
    mdt`${snap.count} open  ·  margin ${snap.totalMargin.toFixed(2)} USDT  ·  uPnL ${usd(snap.totalPnl)}  ·  ROI ${pct(snap.roi)}`,
    '',
  ];
  const body = (snap.positions || []).map((p) => {
    const e = Number(p.unrealizedPNL || 0) >= 0 ? '🟢' : '🔴';
    // Every field is read through a numeric guard: a position row missing
    // `margin` or `marginMode` used to throw here and take the whole /positions
    // view down, rather than showing the row with a "—" where the gap is.
    const margin = Number(p.margin);
    const mode = p.marginMode ? ` ${p.marginMode}` : '';
    const liq = Number(p.liqPrice);
    return [
      `${e} ${bold(`${p.symbol} ${p.side}`)} ${md(`${p.leverage}x${mode}`)}`,
      mdt`   qty ${p.qty ?? '?'}  ·  entry ${fmtNum(p.avgOpenPrice, 6)}  ·  liq ${Number.isFinite(liq) && liq > 0 ? fmtNum(liq, 6) : '—'}`,
      mdt`   margin ${Number.isFinite(margin) ? margin.toFixed(2) : '—'}  ·  uPnL ${usd(p.unrealizedPNL)}  ·  ROI ${pct(p.roi)}`,
      mdt`   id ${p.positionId ?? '—'}`,
    ].join('\n');
  });
  return head.concat(body).join('\n');
}

export function formatBalance(b) {
  return [
    bold('Balance'),
    mdt`available   ${Number(b.available).toFixed(4)} USDT`,
    mdt`in margin   ${Number(b.margin).toFixed(4)} USDT`,
    mdt`frozen      ${Number(b.frozen).toFixed(4)} USDT`,
    mdt`unrealised  ${usd(b.unrealized)}`,
    mdt`bonus       ${Number(b.bonus).toFixed(4)} USDT`,
    mdt`mode        ${b.positionMode}`,
  ].join('\n');
}

/**
 * Every setting, with what it means and what it accepts.
 * This is the single source of truth for /settings and /set validation.
 */
export const SETTING_INFO = {
  // ---- trading
  auto_trade:               ['Open trades automatically. Off = signals only.', 'true / false'],
  leverage:                 ['Leverage applied to every new position.', 'clamped to each pair\'s min/max'],
  margin_mode:              ['CROSS shares margin across positions; ISOLATION ring-fences it.', 'CROSS / ISOLATION'],
  position_mode:            ['HEDGE allows a long and a short on one symbol at once.', 'HEDGE / ONE_WAY'],
  order_unit:               ['How your sizing number is read. COST = the margin you commit (notional = cost x leverage). NOMINAL = the position value itself (margin = value / leverage). QTY = base coin. All three end up as base coin for the exchange.', 'NOMINAL | COST | QTY'],
  margin_pct:               ['Percent of available balance committed as margin per trade.', '0.1 – 100'],
  max_open_positions:       ['Hard ceiling on concurrent positions.', '1 – 50'],
  symbols:                  ['AUTO ranks every tradable pair by volume; or a comma list.', 'AUTO / BTCUSDT,ETHUSDT'],
  universe_size:            ['How many symbols AUTO keeps in the scan universe, best first. The rest of the 685 pairs are ignored.', '1 – 200'],
  tp_mode:                  ['ADAPTIVE reads the tape: a strong expanding trend gets NO fixed target and exits on the trailing stop, a range targets the opposite band, chop takes a tight 1.5R. FIXED_R is a confidence-scaled multiple of the stop, the old behaviour.', 'ADAPTIVE | FIXED_R'],
  tpsl_method:              ['How a new position is protected. POSITION = one TP/SL closing all of it. PARTIAL = a scale-out ladder on top, banking profit in stages with a runner left on.', 'POSITION | PARTIAL'],
  partial_tp_ladder:        ['The scale-out ladder, as share@R pairs. "40@1,35@2,25@3" closes 40% at 1R, 35% at 2R, 25% at 3R. Shares must sum to 100 or less; whatever is left rides as the runner.', 'e.g. 40@1,35@2,25@3'],
  trailing_method:          ['ATR = stop sits N ATR behind price. RATIO = exchange-style callback, a percentage retrace from the best price. INTERVAL = the same but an absolute price distance.', 'ATR | RATIO | INTERVAL'],
  trailing_callback:        ['The retrace that closes the position, once trailing is armed. A percentage of the best price when trailing_method is RATIO, an absolute price distance when INTERVAL. Ignored for ATR.', 'e.g. 1.5'],
  account_tp_usdt:          ['Close EVERY position once total unrealised profit reaches this many USDT. 0 disables it.', 'USDT, 0 = off'],
  account_sl_usdt:          ['Close EVERY position once total unrealised loss reaches this many USDT (enter it positive). 0 disables it.', 'USDT, 0 = off'],
  heartbeat_minutes:        ['When there are no positions and no signals, how often to send a one-line "still alive" ping instead of staying completely silent.', 'minutes, e.g. 15'],
  universe_rank:            ['How the pairs that clear the liquidity floor are ordered. VOLUME = deepest books first. GAINERS = biggest 24h rise first. LOSERS = biggest 24h fall. MOVERS = biggest move either way.', 'VOLUME | GAINERS | LOSERS | MOVERS'],
  min_24h_volume_usd:       ['Liquidity floor. Pairs thinner than this are never scanned — a stop can be swept on an illiquid book.', 'USD, e.g. 20000000'],
  timeframes:               ['Timeframes analysed. The shortest is the execution timeframe; the others confirm.', '1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M'],

  // ---- signal gates
  min_agreement:            ['How many strategies must agree before a signal qualifies.', '1 – 10'],
  min_confidence:           ['Minimum consensus confidence to act on.', '0 – 100'],
  tf_min_confidence:        ['Minimum confidence for a single timeframe to count as a vote.', '0 – 100'],
  signal_confirm_scans:     ['Consecutive scans a signal must survive before entry.', '1 – 10'],
  cooldown_min:             ['Minutes a symbol is benched after a trade closes.', 'minutes'],

  // ---- reversal
  reversal_enabled:         ['Flip a losing position when the opposite case becomes strong.', 'true / false'],
  reversal_confidence:      ['Confidence required to flip an open position.', '0 – 100'],

  // ---- protection
  liq_distance:             ['Safety gap between the stop and the liquidation price, as a fraction of the entry-to-liq distance. 0.50 = the stop never uses more than half of it.', '0.05 - 0.9'],
  breakeven_threshold:      ['ROI % at which the stop is pulled to entry.', 'percent ROI'],
  trailing_trigger_roi_pct: ['ROI % at which the trailing stop starts following price.', 'percent ROI'],
  trailing_distance_atr:    ['How far behind price the trailing stop sits, in ATR. Smaller = tighter = stopped out sooner.', '0.1 – 5'],

  // ---- loops
  scan_interval_sec:        ['How often the market is scanned for new signals.', 'seconds'],
  manage_interval_sec:      ['How often open positions are re-evaluated.', 'seconds'],
  guard_interval_sec:       ['How often the risk guard sweeps for TP/SL drift.', 'seconds'],
  report_interval_sec:      ['How often the signal + PnL report is pushed.', 'seconds'],
  agent_autonomous_sec:     ['How often the agent gets a free turn to act on its own.', 'seconds'],

  // ---- agent
  thinking_level:           ['Reasoning budget per decision. Higher = slower, sharper.', 'off / low / medium / high'],
  autocompact:              ['Fold old chat into summaries so context never overflows.', 'true / false'],
  auto_refresh_model:       ['Re-probe and switch model when the active one starts failing.', 'true / false'],
  dream_enabled:            ['Off-hours reflection: review my own closed trades and write the patterns back as lessons. Never trades.', 'true / false'],
  dream_interval_hours:     ['How often the dream pass runs (skipped while a position is open).', '1 - 720'],
};

const SETTING_GROUPS = {
  'Trading':     ['auto_trade', 'leverage', 'margin_mode', 'position_mode', 'order_unit', 'margin_pct', 'max_open_positions', 'symbols', 'universe_rank', 'universe_size', 'min_24h_volume_usd', 'timeframes'],
  'TP / SL':     ['tp_mode', 'tpsl_method', 'partial_tp_ladder', 'trailing_method', 'trailing_callback', 'trailing_distance_atr', 'trailing_trigger_roi_pct', 'breakeven_threshold', 'liq_distance', 'account_tp_usdt', 'account_sl_usdt'],
  'Signal gates': ['min_agreement', 'min_confidence', 'tf_min_confidence', 'signal_confirm_scans', 'cooldown_min'],
  'Reversal':    ['reversal_enabled', 'reversal_confidence'],
  'Protection':  ['breakeven_threshold', 'trailing_trigger_roi_pct', 'trailing_distance_atr'],
  'Intervals':   ['scan_interval_sec', 'manage_interval_sec', 'guard_interval_sec', 'report_interval_sec', 'agent_autonomous_sec'],
  'Agent':       ['thinking_level', 'autocompact', 'auto_refresh_model', 'dream_enabled', 'dream_interval_hours'],
};

/** Which group a /settings argument refers to. */
export const SETTING_SECTIONS = {
  trade: ['Trading'], trading: ['Trading'],
  signal: ['Signal gates'], signals: ['Signal gates'], gates: ['Signal gates'],
  risk: ['Protection', 'Reversal'], protection: ['Protection', 'Reversal'],
  reversal: ['Reversal'],
  intervals: ['Intervals'], loops: ['Intervals'], timing: ['Intervals'],
  agent: ['Agent'], ai: ['Agent'],
};

const val = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/**
 * @param s        current settings
 * @param section  null = everything compact; a group name = detailed view
 */
export function formatSettings(s, section = null) {
  const wanted = section ? SETTING_SECTIONS[String(section).toLowerCase()] : null;
  if (section && !wanted) {
    return [
      mdt`No settings section called "${section}".`, '',
      bold('Sections'),
      md('  /settings trade · signals · risk · intervals · agent'),
    ].join('\n');
  }

  const groups = wanted
    ? Object.fromEntries(wanted.map((g) => [g, SETTING_GROUPS[g]]))
    : SETTING_GROUPS;

  const out = [bold(wanted ? `⚙️ Settings — ${wanted.join(' & ')}` : '⚙️ Settings')];

  // Detailed view: value + what it does + accepted range.
  if (wanted) {
    for (const [g, keys] of Object.entries(groups)) {
      if (Object.keys(groups).length > 1) out.push('', bold(g));
      for (const k of keys) {
        const [desc, range] = SETTING_INFO[k] || ['', ''];
        out.push('', mdt`${k} = ${val(s[k])}`);
        if (desc) out.push(italic(`   ${desc}`));
        if (range) out.push(italic(`   accepts: ${range}`));
      }
    }
    out.push('', md('change with:  /set <key> <value>'));
    return out.join('\n');
  }

  // Compact view: everything at a glance.
  out.push(italic('/settings trade · signals · risk · intervals · agent — for detail'));
  for (const [g, keys] of Object.entries(groups)) {
    out.push('', bold(g));
    for (const k of keys) out.push(mdt`  ${k} = ${val(s[k])}`);
  }
  out.push('', bold('TP / SL'));
  out.push(italic('  always dynamic — ATR x signal strength, never a fixed %'));
  out.push('', md('change with:  /set <key> <value>'));
  return out.join('\n');
}

export function formatReport({ snapshot, signals, balance, stats }) {
  const lines = [bold('📊 Report'), ''];
  lines.push(mdt`balance ${Number(balance.available).toFixed(2)} USDT  ·  positions ${snapshot.count}  ·  uPnL ${usd(snapshot.totalPnl)}`);
  if (stats) lines.push(mdt`7d: ${stats.trades} trades, ${stats.wins}W/${stats.losses}L, PnL ${usd(stats.pnl, 2)}`);

  if (snapshot.count) {
    lines.push('', bold('Positions'));
    for (const p of snapshot.positions) {
      const e = p.unrealizedPNL >= 0 ? '🟢' : '🔴';
      lines.push(mdt`${e} ${p.symbol} ${p.side} ${p.leverage}x  ·  ${usd(p.unrealizedPNL)}  ·  ROI ${pct(p.roi)}`);
    }
  }
  const qualified = (signals || []).filter((s) => s.qualified);
  const watch = (signals || []).filter((s) => !s.qualified).slice(0, 4);
  if (qualified.length) {
    lines.push('', bold('Signals'));
    for (const s of qualified) {
      lines.push(mdt`${s.side === 'LONG' ? '🟩' : '🟥'} ${s.symbol} ${s.side} ${s.confidence}% (${s.agreement}/${STRATEGY_COUNT}) ${s.regime}`);
    }
  }
  if (watch.length) {
    lines.push('', bold('Watchlist'));
    for (const s of watch) {
      lines.push(mdt`· ${s.symbol} ${s.side} ${s.confidence}% — ${s.rejectReason}`);
    }
  }
  if (!qualified.length && !watch.length) lines.push('', italic('no signals this cycle'));
  return lines.join('\n');
}

export const HELP = [
  md('/diag — test the notification chain: push target, exchange reads, loop health'),
  bold('🤖 AI Agent Trader — commands'),
  '',
  bold('Talk to me'),
  'Just write normally\\. I read the market, use my tools and answer\\.',
  mdt`e.g. "why is BTC weak?", "close everything", "size down, market is choppy"`,
  '',
  bold('Account'),
  '/balance — futures balance',
  '/positions — open positions with ROI',
  '/position\\_history — closed positions',
  '/order\\_history — past orders',
  '/pnl — performance summary',
  '',
  bold('Trading'),
  '/signal — scan now and show signals',
  '/analyse SYMBOL — deep multi\\-timeframe analysis',
  '/close SYMBOL\\|positionId — close a position',
  '/closeall — close everything',
  '/auto\\_trade on\\|off — turn auto trading on or off',
  '/scan on\\|off — the scanner itself (separate from auto trading)',
  '/report on\\|off — the periodic Telegram push',
  '',
  bold('Configuration'),
  '/settings — every trade setting at a glance',
  '/settings trade\\|signals\\|risk\\|intervals\\|agent — with explanations',
  '/set key value — change a setting',
  '/leverage [N] — show or set leverage (asks to confirm with positions open)',
  '/margin\\_mode CROSS\\|ISOLATION',
  '/position\\_mode HEDGE\\|ONE\\_WAY',
  '/order\\_unit NOMINAL\\|COST\\|QTY',
  '/calc AMOUNT NOMINAL\\|COST\\|QTY [lev] [SYMBOL] — work out an order size at the live price',
  '/symbol [SYMBOL] — the trading universe',
  '/margin\\_pct [N] — share of available balance per position',
  '/liq\\_distance [0.05\u20130.9] — how much of the distance to liquidation the stop may use',
  '/breakeven [ROI%] — ROI at which the stop moves to entry',
  '/trailing [ROI%] — ROI at which the stop starts following price',
  '/scan\\_interval [s] · /guard\\_interval [s] · /report [s]',
  '/thinking off\\|low\\|medium\\|high',
  '',
  bold('Memory and sessions'),
  '/memory — what I have learned',
  '/memory sessions — saved conversation bookmarks',
  '/memory save NAME — bookmark this conversation',
  '/memory resume ID — restore a saved conversation',
  '/memory clear ID — delete a bookmark',
  '/resume — auto-trade on (the original meaning, kept)',
  '/dream on\\|off\\|now\\|what — off-hours reflection on my own results',
  '',
  bold('System'),
  '/status — agent, exchange and model status',
  '/model or /models — show active AI models',
  '/models list — what your key can actually call',
  '/models set openai gpt\\-4o — pin a model',
  '/models reset — re\\-probe everything',
  '/memory — what I have learned',
  '/skills — skills I have been taught',
  '/skills add \\<name\\> \\| \\<text\\> — teach me something',
  '/reload — re\\-read soul/ from disk',
  '/mcp — external MCP servers and their tools',
  '/help — this message',
].join('\n');
