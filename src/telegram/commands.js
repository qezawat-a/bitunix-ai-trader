import fs from 'node:fs';
import path from 'node:path';
import bitunix from '../exchange/bitunix.js';
import ai from '../ai/providers.js';
import agent from '../ai/agent.js';
import { loadSkillFiles, SKILLS_DIR } from '../ai/soul.js';
import { mcpStatus, reloadMcpTools, allTools } from '../ai/tools.js';
import { createLogger } from '../logger.js';
import { config } from '../config.js';
import * as db from '../db/index.js';
import { scan, analyseSymbol, consensus } from '../scanner/scanner.js';
import { validateSetting } from '../settings-schema.js';
import { availableBalance, closePosition, closeAll, resetSymbolConfigCache } from '../trading/executor.js';
import { portfolioSnapshot, livePositions, exchangePerformance } from '../trading/manager.js';
import {
  HELP, md, mdt, bold, italic, fmtNum, usd, pct, agentText,
  formatSignal, formatPositions, formatBalance, formatSettings,
  SETTING_INFO, SETTING_SECTIONS,
} from './format.js';

/** Unknown-key reply with "did you mean" suggestions. */
function unknownKey(key, all) {
  const keys = Object.keys(all);
  const near = keys.filter((k) => k.includes(key) || key.includes(k)
    || k.split('_').some((part) => key.includes(part)));
  return [
    mdt`No setting called "${key}".`,
    near.length ? '' : null,
    near.length ? bold('Did you mean') : null,
    near.length ? md(near.slice(0, 5).map((k) => `  ${k}`).join('\n')) : null,
    '', italic('/settings lists every key.'),
  ].filter((x) => x !== null).join('\n');
}

const log = createLogger('cmd');

function coerce(key, raw) { return validateSetting(key, raw); }

/**
 * Command router. `ctx` provides shared runtime handles:
 *   { bot, orchestrator }
 */
export function createCommandHandler(ctx) {
  const { bot, orchestrator } = ctx;
  const reply = (chatId, text, extra) => bot.sendMessage(chatId, text, extra);

  const commands = {
    // ------------------------------------------------------------ lifecycle
    async start(chatId) {
      const s = db.settings();
      await reply(chatId, [
        mdt`👋 ${config.agentName} online.`,
        '',
        mdt`I am an AI agent trading Bitunix USDT-M futures on a LIVE account.`,
        mdt`auto trade: ${s.auto_trade ? 'ON' : 'OFF'}  ·  universe: ${s.symbols}  ·  ${s.leverage}x ${s.margin_mode} ${s.position_mode}`,
        mdt`gates: ${s.min_agreement}/6 agreement, ${s.min_confidence}% confidence, ${s.cooldown_min}m cooldown`,
        mdt`thinking: ${s.thinking_level}  ·  model: ${ai.status().map((p) => p.model).join(', ')}`,
        '',
        italic('Talk to me normally, or use /help for commands.'),
      ].join('\n'));
    },

    async help(chatId) { await reply(chatId, HELP); },

    /**
     * Test every link in the notification chain and report which one is broken.
     *
     * Exists because "nothing is happening" is not a diagnosis: reports can go
     * missing because no chat is configured to push to, because the exchange
     * read fails, because a loop is erroring, or because Telegram rejected the
     * message. Each of those looks identical from the outside.
     */
    async diag(chatId) {
      await bot.sendTyping(chatId);
      const L = [bold('🩺 Diagnostics'), ''];
      const ok = (b) => (b ? '✅' : '❌');

      // 1. can the bot push unprompted messages at all?
      const ids = orchestrator?.chatIds || [];
      L.push(bold('Push target'));
      L.push(mdt`${ok(ids.length)} TELEGRAM_ALLOWED_CHAT_IDS: ${ids.length} configured`);
      if (!ids.length) {
        L.push(italic('Empty: the bot answers commands but can never push a report, signal or alarm.'));
      } else if (!ids.map(String).includes(String(chatId))) {
        L.push(italic('This chat is NOT in the list — reports are being pushed somewhere else.'));
      }

      // 2. exchange reads
      L.push('', bold('Exchange'));
      for (const [label, fn] of [
        ['balance', () => availableBalance()],
        ['positions', () => portfolioSnapshot()],
        ['history', () => exchangePerformance(1)],
      ]) {
        try {
          const r = await fn();
          const detail = label === 'balance' ? `${Number(r.available).toFixed(2)} USDT`
            : label === 'positions' ? `${r.count} open`
              : `${r.trades} closed in 24h`;
          L.push(mdt`✅ ${label}: ${detail}`);
        } catch (e) {
          L.push(mdt`❌ ${label}: ${e.message}`);
        }
      }

      // 3. loops
      L.push('', bold('Loops'));
      const f = orchestrator?.failures || {};
      for (const name of ['scan', 'manage', 'guard', 'report', 'autonomous']) {
        const st = f[name];
        if (!st) { L.push(mdt`· ${name}: not started`); continue; }
        L.push(st.count
          ? mdt`❌ ${name}: failing ${st.count}x — ${st.lastError || 'unknown'}`
          : mdt`✅ ${name}: healthy`);
      }
      const st = orchestrator?.stats || {};
      L.push('', mdt`scans ${st.scans ?? 0} · signals ${st.signals ?? 0} · trades ${st.trades ?? 0} · errors ${st.errors ?? 0}`);

      // 4. why the report loop may be quiet
      L.push('', bold('Report loop'));
      if (orchestrator?._unreadable) L.push(mdt`⚠️ paused: ${orchestrator._unreadable}`);
      else L.push(italic('Reports send when there are positions or signals; otherwise a heartbeat every heartbeat_minutes.'));

      await reply(chatId, L.join('\n'));
    },

    async status(chatId) {
      const [bal, snap, cd, stats] = await Promise.all([
        availableBalance().catch((e) => ({ error: e.message })),
        portfolioSnapshot().catch((e) => ({ error: e.message, count: 0, totalPnl: 0, totalMargin: 0 })),
        db.activeCooldowns().catch(() => []),
        db.tradeStats(7).catch(() => null),
      ]);
      const s = db.settings();
      const lines = [
        bold('🧭 Status'), '',
        bold('Agent'),
        mdt`  auto trade ${s.auto_trade ? 'ON' : 'OFF'}  ·  thinking ${s.thinking_level}  ·  autocompact ${s.autocompact}`,
        mdt`  loops: scan ${s.scan_interval_sec}s · manage ${s.manage_interval_sec}s · guard ${s.guard_interval_sec}s · report ${s.report_interval_sec}s · autonomous ${s.agent_autonomous_sec}s`,
        '',
        bold('Models'),
        ...ai.status().map((p) => mdt`  ${p.provider}: ${p.model}`),
        '',
        bold('Exchange'),
        bal.error ? mdt`  ⚠️ ${bal.error}` : mdt`  available ${Number(bal.available).toFixed(2)} USDT  ·  margin ${Number(bal.margin).toFixed(2)}  ·  mode ${bal.positionMode}`,
        mdt`  positions ${snap.count}  ·  uPnL ${usd(snap.totalPnl)}`,
        stats ? mdt`  7d: ${stats.trades} trades ${stats.wins}W/${stats.losses}L PnL ${usd(stats.pnl, 2)}` : '',
        cd.length ? mdt`  cooldown: ${cd.map((c) => c.symbol).join(', ')}` : '',
      ].filter(Boolean);
      await reply(chatId, lines.join('\n'));
    },

    /**
     * /models                     -> show what is active
     * /models refresh             -> re-probe (keeps the rejected list)
     * /models reset               -> re-probe from scratch, forget rejections
     * /models list [provider]     -> everything the key can actually see
     * /models set <prov> <model>  -> pin a model (probed before it is accepted)
     * /models set <prov> AUTO     -> back to automatic
     */
    async models(chatId, args) {
      const sub = (args[0] || '').toLowerCase();
      await bot.sendTyping(chatId);

      if (sub === 'list') {
        const all = await ai.listAvailable(args[1]?.toLowerCase() || null);
        const lines = [bold('📋 Models your key can call')];
        for (const [prov, ids] of Object.entries(all)) {
          lines.push('', bold(prov));
          if (ids.error) { lines.push(mdt`  ⚠️ ${ids.error}`); continue; }
          lines.push(...ids.slice(0, 25).map((id, i) => mdt`  ${i + 1}. ${id}`));
          if (ids.length > 25) lines.push(italic(`  …and ${ids.length - 25} more`));
        }
        lines.push('', italic('pin one with: /models set <provider> <model>'));
        return reply(chatId, lines.join('\n'));
      }

      if (sub === 'set') {
        const [, prov, ...rest] = args;
        const modelId = rest.join(' ');
        if (!prov || !modelId) {
          return reply(chatId, mdt`Usage: /models set <openai|gemini|anthropic> <model|AUTO>`);
        }
        try {
          const st = await ai.setModel(prov.toLowerCase(), modelId);
          return reply(chatId, [bold('✅ Model set'), '',
            ...st.map((p) => mdt`${p.active ? '▸' : ' '} ${p.provider}: ${p.model}${p.pinned ? ' (pinned)' : ''}`)].join('\n'));
        } catch (e) {
          return reply(chatId, mdt`❌ ${e.message}`);
        }
      }

      if (sub === 'refresh' || sub === 'reset') {
        const st = await ai.refreshModels({ clearBlacklist: sub === 'reset' });
        const lines = [bold(sub === 'reset' ? '🔄 Models re-probed from scratch' : '🔄 Models refreshed'), ''];
        for (const p of st) {
          lines.push(mdt`${p.active ? '▸' : ' '} ${p.provider}: ${p.model}${p.pinned ? ' (pinned)' : ''}`);
          if (p.rejected?.length) lines.push(italic(`    rejected: ${p.rejected.join(', ')}`));
        }
        return reply(chatId, lines.join('\n'));
      }

      // default: just show the current state
      const st = ai.status();
      const lines = [bold('🧠 AI models'), ''];
      for (const p of st) {
        const tags = [p.pinned ? 'pinned' : null, p.tools === false ? '⚠️ no tool calling' : null]
          .filter(Boolean).join(', ');
        lines.push(mdt`${p.active ? '▸' : ' '} ${p.provider}: ${p.model}${tags ? ` (${tags})` : ''}`);
        if (p.rejected?.length) {
          lines.push(italic(`    unavailable to your key: ${p.rejected.slice(0, 6).join(', ')}`));
        }
      }
      lines.push('', italic('/models list · /models refresh · /models reset · /models set <prov> <model>'));
      lines.push(italic('On a relay/gateway, model names are whatever the operator configured — use /models list.'));
      return reply(chatId, lines.join('\n'));
    },

    // -------------------------------------------------------------- account
    /** /model — same as /models, because everyone types the singular. */
    async model(chatId, args) { return commands.models(chatId, args); },

    async balance(chatId) {
      const b = await availableBalance();
      await reply(chatId, formatBalance(b));
    },

    async positions(chatId) {
      // An exchange error used to fall through as an empty snapshot, so
      // "no open positions" and "I could not read the account" printed the
      // same thing. They mean opposite things; say which one happened.
      let snap;
      try {
        snap = await portfolioSnapshot();
      } catch (e) {
        return reply(chatId, [
          bold('⚠️ Cannot read positions'), '',
          mdt`${e.message}`,
          italic('This is NOT the same as having no positions — the account could not be reached.'),
        ].join('\n'));
      }
      await reply(chatId, formatPositions(snap));
    },

    async position_history(chatId, args) {
      const symbol = args[0]?.toUpperCase();
      const h = await bitunix.getHistoryPositions({ symbol, limit: 10 });
      const list = h?.positionList || [];
      if (!list.length) return reply(chatId, 'No closed positions\\.');
      const lines = [bold('📜 Position history'), ''];
      for (const p of list) {
        const pnl = Number(p.realizedPNL || 0);
        lines.push(
          mdt`${pnl >= 0 ? '🟢' : '🔴'} ${p.symbol} ${p.side} ${p.leverage}x  ·  ${usd(pnl)}`,
          mdt`   entry ${fmtNum(p.entryPrice, 6)} → exit ${fmtNum(p.closePrice, 6)}  ·  fee ${p.fee}  ·  funding ${p.funding}`,
          mdt`   ${new Date(Number(p.mtime)).toISOString().replace('T', ' ').slice(0, 16)}`,
        );
      }
      await reply(chatId, lines.join('\n'));
    },

    async order_history(chatId, args) {
      const symbol = args[0]?.toUpperCase();
      const h = await bitunix.getHistoryOrders({ symbol, limit: 10 });
      const list = h?.orderList || [];
      if (!list.length) return reply(chatId, 'No order history\\.');
      const lines = [bold('🧾 Order history'), ''];
      for (const o of list) {
        lines.push(
          mdt`${o.symbol} ${o.side} ${o.orderType} ${o.status}`,
          mdt`   qty ${o.qty} filled ${o.tradeQty} @ ${fmtNum(o.price, 6)}  ·  fee ${o.fee}  ·  pnl ${o.realizedPNL}`,
          mdt`   ${new Date(Number(o.ctime)).toISOString().replace('T', ' ').slice(0, 16)}  ·  id ${o.orderId}`,
        );
      }
      await reply(chatId, lines.join('\n'));
    },

    async pnl(chatId) {
      await bot.sendTyping(chatId);
      // The account's own history is the source of truth: the local trades
      // table only ever contains positions THIS bot opened, so anything traded
      // by hand or while auto_trade was off would read as zero.
      let ex = null;
      try {
        ex = await Promise.all([
          exchangePerformance(1), exchangePerformance(7), exchangePerformance(30),
        ]);
      } catch (e) {
        ex = null;
        log.warn(`exchange performance unavailable: ${e.message}`);
      }
      const [b1, b7, b30] = await Promise.all([db.tradeStats(1), db.tradeStats(7), db.tradeStats(30)]);
      const { rows } = await db.strategyWeights();
      let snap;
      try { snap = await portfolioSnapshot(); }
      catch (e) { snap = { error: e.message, count: 0, totalPnl: 0 }; }

      const line = (label, s) => mdt`${label}: ${s.trades} trades  ${s.wins}W/${s.losses}L  PnL ${usd(s.pnl, 2)}${s.trades > 0 ? `  (${((s.wins / s.trades) * 100).toFixed(0)}% win)` : ''}`;

      const lines = [bold('📈 Performance'), ''];
      if (ex) {
        lines.push(italic('account — every closed position, however it was opened'));
        lines.push(line('24h', ex[0]), line('7d', ex[1]), line('30d', ex[2]));
        const f = ex[2];
        if (f.fees || f.funding) {
          lines.push(mdt`30d fees ${usd(f.fees, 4)} · funding ${usd(f.funding, 4)} · net ${usd(f.net, 2)}`);
        }
      } else {
        lines.push(italic('account history unavailable — showing bot-tracked trades only'));
      }

      const botTraded = b30.trades > 0;
      if (botTraded || !ex) {
        lines.push('', italic('opened by this bot'));
        lines.push(line('24h', b1), line('7d', b7), line('30d', b30));
      }

      lines.push('', snap.error
        ? mdt`open: could not read positions — ${snap.error}`
        : mdt`open: ${snap.count} positions, uPnL ${usd(snap.totalPnl)}`);
      if (rows.length) {
        lines.push('', bold('Strategy weights'));
        for (const r of rows.sort((a, b) => b.weight - a.weight)) {
          lines.push(mdt`  ${r.strategy}: w=${Number(r.weight).toFixed(2)}  ${r.wins}W/${r.losses}L  ${usd(r.pnl, 2)}`);
        }
      }
      await reply(chatId, lines.join('\n'));
    },

    // -------------------------------------------------------------- trading
    async signal(chatId, args) {
      await bot.sendTyping(chatId);
      const only = args.length ? args.map((a) => a.toUpperCase()) : null;
      const sigs = await scan({ onlySymbols: only });
      if (!sigs.length) return reply(chatId, '🔍 No signals\\. Market is not offering anything that clears the filters\\.');
      const top = sigs.slice(0, 5);
      for (const s of top) await reply(chatId, formatSignal(s));
      const rest = sigs.length - top.length;
      if (rest > 0) await reply(chatId, italic(`+${rest} more below the threshold`));
    },
    scan(chatId, args) { return commands.signal(chatId, args); },

    async analyse(chatId, args) {
      const symbol = (args[0] || 'BTCUSDT').toUpperCase();
      await bot.sendTyping(chatId);
      const a = await analyseSymbol(symbol);
      const c = await consensus(a);
      const lines = [bold(`🔬 ${symbol}`), '',
        mdt`price ${fmtNum(a.price, 6)}  ·  regime ${a.regime}  ·  ATR ${fmtNum(a.atr, 6)}`];
      for (const [tf, v] of Object.entries(a.timeframes)) {
        if (v.error) { lines.push(mdt`${tf}: ${v.error}`); continue; }
        lines.push('', mdt`${tf} — ${v.regime}, ADX ${v.adx}, ATR ${v.atrPct.toFixed(3)}%`);
        for (const r of v.results) {
          lines.push(r.side
            ? mdt`   ${r.side === 'LONG' ? '↑' : '↓'} ${r.name} ${Math.round(r.confidence)}% — ${r.notes.join(', ')}`
            : mdt`   · ${r.name} — ${r.notes[0]}`);
        }
      }
      lines.push('');
      lines.push(c ? mdt`Consensus: ${c.side} ${c.confidence}% (${c.agreement}/6)${c.qualified === false ? ` — blocked: ${c.rejectReason || 'gates'}` : ''}`
        : italic('No consensus — strategies disagree or nothing fired.'));
      await reply(chatId, lines.join('\n'));
      if (c) {
        const r = await agent.run({
          chatId, subject: symbol, persist: false,
          userMessage: `Give me your honest read on ${symbol} right now. Consensus says ${c.side} at ${c.confidence}% with ${c.agreement}/6 agreement in a ${c.regime} regime. Two short paragraphs: what the setup is, and what would make you not take it.`,
        });
        if (r.text) await reply(chatId, agentText(r.text));
      }
    },

    async close(chatId, args) {
      const target = args[0];
      if (!target) return reply(chatId, 'Usage: /close SYMBOL or /close positionId');
      const ps = await livePositions();
      const match = ps.find((p) => String(p.positionId) === target)
        || ps.find((p) => p.symbol === target.toUpperCase());
      if (!match) return reply(chatId, mdt`No open position for ${target}.`);
      const r = await closePosition(match.positionId, 'manual /close');
      await reply(chatId, r.ok
        ? mdt`✅ Closing ${match.symbol} ${match.side} (uPnL ${match.unrealizedPNL.toFixed(4)} USDT)`
        : mdt`❌ ${r.reason}`);
    },

    async closeall(chatId) {
      const r = await closeAll();
      await reply(chatId, r.ok ? '✅ Closing all positions\\.' : mdt`❌ ${r.reason}`);
    },

    /**
     * /auto_trade            -> show state
     * /auto_trade on|off     -> flip it
     * Off means: keep scanning, keep guarding and managing what is already
     * open, keep talking — just do not OPEN anything new by myself.
     */
    async auto_trade(chatId, args) {
      const cur = db.settings().auto_trade;
      const raw = (args[0] || '').toLowerCase();

      if (!raw) {
        return reply(chatId, [
          cur ? bold('▶️ Auto trade is ON') : bold('⏸ Auto trade is OFF'),
          '',
          italic(cur
            ? 'I open positions myself when a signal clears every gate and my judgement agrees.'
            : 'I scan, report and guard open positions — but I will not open anything new on my own.'),
          '',
          md(`turn it ${cur ? 'off' : 'on'}:  /auto_trade ${cur ? 'off' : 'on'}`),
        ].join('\n'));
      }

      const ON = ['on', 'true', '1', 'yes', 'start', 'enable', 'enabled'];
      const OFF = ['off', 'false', '0', 'no', 'stop', 'disable', 'disabled'];
      if (![...ON, ...OFF].includes(raw)) {
        return reply(chatId, mdt`Usage: /auto_trade on | /auto_trade off`);
      }

      const want = ON.includes(raw);
      if (want === cur) {
        return reply(chatId, mdt`Auto trade is already ${want ? 'on' : 'off'}.`);
      }

      const res = await db.setSetting('auto_trade', want, 'user');
      const warn = res.persisted ? null
        : italic('⚠️ Applied now, but not saved — the database is unreachable, so this resets if I restart.');

      if (want) {
        const s2 = db.settings();
        return reply(chatId, [
          bold('▶️ Auto trade ON'),
          '',
          mdt`I will open positions that clear ${s2.min_agreement}/6 agreement and ${s2.min_confidence}% confidence, up to ${s2.max_open_positions} at once, sizing ${s2.margin_pct}% of available margin each.`,
          italic('TP/SL are dynamic — ATR x signal strength, set at entry.'),
          warn ? '' : null, warn,
        ].filter((x) => x !== null).join('\n'));
      }

      const open = await livePositions().catch(() => []);
      return reply(chatId, [
        bold('⏸ Auto trade OFF'),
        '',
        md('I will not open anything new by myself.'),
        open.length
          ? mdt`${open.length} open position(s) stay open — I keep managing their TP/SL and trailing stops. Use /closeall to flatten.`
          : md('Nothing is open right now.'),
        '',
        italic('I still scan, report and answer you. /auto_trade on to resume.'),
        warn ? '' : null, warn,
      ].filter((x) => x !== null).join('\n'));
    },

    /** Aliases kept so muscle memory still works. */
    async pause(chatId) { return commands.auto_trade(chatId, ['off']); },
    async resume(chatId) { return commands.auto_trade(chatId, ['on']); },
    async autotrade(chatId, args) { return commands.auto_trade(chatId, args); },
    async auto(chatId, args) { return commands.auto_trade(chatId, args); },

    // --------------------------------------------------------------- config
    /** /settings — everything · /settings trade|signals|risk|intervals|agent — detail */
    async settings(chatId, args) {
      await reply(chatId, formatSettings(db.settings(), args[0] || null));
    },

    async set(chatId, args) {
      const all = db.settings();

      if (!args.length) {
        return reply(chatId, [
          bold('Usage'), md('/set <key> <value>'), '',
          md('Example:  /set min_confidence 85'), '',
          italic('/settings shows every key and its current value.'),
        ].join('\n'));
      }

      const key = args[0].toLowerCase();

      // /set <key>  with no value -> explain the key instead of erroring
      if (args.length === 1) {
        if (!(key in all)) return reply(chatId, unknownKey(key, all));
        const [desc, range] = SETTING_INFO[key] || ['', ''];
        return reply(chatId, [
          mdt`${key} = ${typeof all[key] === 'boolean' ? (all[key] ? 'on' : 'off') : all[key]}`,
          desc ? italic(desc) : null,
          range ? italic(`accepts: ${range}`) : null,
          '', md(`change it:  /set ${key} <value>`),
        ].filter(Boolean).join('\n'));
      }

      const raw = args.slice(1).join(' ');
      if (!(key in all)) return reply(chatId, unknownKey(key, all));
      try {
        const value = coerce(key, raw);
        await db.setSetting(key, value, 'user');
        resetSymbolConfigCache();
        orchestrator?.rescheduleLoops?.();
        await reply(chatId, mdt`✅ ${key} = ${JSON.stringify(value)}`);
      } catch (e) { await reply(chatId, mdt`❌ ${e.message}`); }
    },

    async margin_mode(chatId, args) {
      const v = (args[0] || '').toUpperCase();
      const norm = v === 'ISOLATED' ? 'ISOLATION' : v;
      if (!['CROSS', 'ISOLATION'].includes(norm)) {
        return reply(chatId, mdt`Current: ${db.settings().margin_mode}. Usage: /margin_mode CROSS|ISOLATION`);
      }
      await db.setSetting('margin_mode', norm, 'user');
      resetSymbolConfigCache();
      await reply(chatId, mdt`✅ margin_mode = ${norm} (cannot change on a symbol that already has a position)`);
    },

    async thinking(chatId, args) {
      const v = (args[0] || '').toLowerCase();
      if (!['off', 'low', 'medium', 'high'].includes(v)) {
        return reply(chatId, mdt`Current: ${db.settings().thinking_level}. Usage: /thinking off|low|medium|high`);
      }
      await db.setSetting('thinking_level', v, 'user');
      await reply(chatId, mdt`✅ thinking_level = ${v}`);
    },

    // ------------------------------------------------------------------ mcp
    /**
     * /mcp           -> which external MCP servers are connected, and their tools
     * /mcp reload    -> re-read mcp.json and restart them
     * /mcp tools     -> every tool the agent can call, built-in and external
     */
    async mcp(chatId, args) {
      const sub = (args[0] || '').toLowerCase();

      if (sub === 'reload') {
        await reply(chatId, '🔄 Restarting MCP servers…');
        const tools = await reloadMcpTools();
        const st = mcpStatus();
        return reply(chatId, [
          mdt`Reloaded — ${st.filter((x) => x.running).length}/${st.length} server(s) up, ${tools.length} external tool(s).`,
          ...st.filter((x) => x.error).map((x) => italic(`${x.name}: ${x.error}`)),
        ].join('\n'));
      }

      if (sub === 'tools') {
        const all = allTools();
        const ext = all.filter((t) => t.external);
        const lines = [bold('🧰 Tools'), '', mdt`${all.length - ext.length} built-in · ${ext.length} external`];
        if (ext.length) {
          lines.push('');
          const byServer = {};
          for (const t of ext) (byServer[t.server] ||= []).push(t.remoteName);
          for (const [srv, names] of Object.entries(byServer)) {
            lines.push(bold(srv), md('  ' + names.join(', ')));
          }
        }
        return reply(chatId, lines.join('\n'));
      }

      const st = mcpStatus();
      if (!st.length) {
        return reply(chatId, [
          bold('🔌 External MCP servers'), '',
          'None configured\\.',
          '',
          italic('Create mcp.json in the project root to give me more tools:'),
          '```json',
          md('{ "mcpServers": { "search": {'),
          md('  "command": "npx",'),
          md('  "args": ["-y", "@modelcontextprotocol/server-brave-search"],'),
          md('  "env": { "BRAVE_API_KEY": "..." } } } }'),
          '```',
          italic('Then /mcp reload. See mcp.example.json.'),
        ].join('\n'));
      }

      const lines = [bold('🔌 External MCP servers'), ''];
      for (const x of st) {
        lines.push(mdt`${x.running ? '🟢' : '🔴'} ${x.name} — ${x.tools} tool(s)`);
        lines.push(italic(`    ${x.command}`));
        if (x.toolNames.length) lines.push(italic(`    ${x.toolNames.slice(0, 8).join(', ')}`));
        if (x.error) lines.push(italic(`    ⚠️ ${x.error}`));
      }
      lines.push('', italic('/mcp reload · /mcp tools'));
      return reply(chatId, lines.join('\n'));
    },

    // --------------------------------------------------------------- skills
    /**
     * /skills                        -> list every skill file and its state
     * /skills show <file>            -> print one skill
     * /skills on|off <file>          -> flip `enabled:` in its front matter
     * /skills add <name> | <text>    -> write a new soul/skills/<name>.md
     * /skills rm <file>              -> delete it
     */
    async skills(chatId, args) {
      const dir = SKILLS_DIR;   // resolved from the module, not the cwd
      const sub = (args[0] || '').toLowerCase();
      const rest = args.slice(1);

      const fileFor = (nameArg) => {
        const want = String(nameArg || '').replace(/\.md$/i, '').toLowerCase();
        const hit = loadSkillFiles().find(
          (k) => k.file.replace(/\.md$/i, '').toLowerCase() === want
              || k.name.toLowerCase() === want.replace(/[-_]/g, ' '),
        );
        return hit ? path.join(dir, hit.file) : null;
      };

      if (!sub) {
        const list = loadSkillFiles();
        const lines = [bold('🎓 Skills'), ''];
        lines.push(mdt`Base: soul/SKILL.md (always on)`);
        if (!list.length) {
          lines.push('', italic('No extra skills yet.'),
            '', italic('Add one:  /skills add funding-carry | When funding is above 0.05% per 8h, fade the crowd'),
            italic('Or drop a .md file into soul/skills/ and run /reload'));
        } else {
          lines.push('');
          for (const k of list) {
            lines.push(mdt`${k.enabled ? '🟢' : '⚪️'} ${k.file} — ${k.name}`);
            if (k.when) lines.push(italic(`    when: ${k.when}`));
          }
          lines.push('', italic('/skills show / on / off / rm <file>'));
          lines.push(italic('/skills add <name> | <text>'));
        }
        return reply(chatId, lines.join('\n'));
      }

      if (sub === 'show') {
        const f = fileFor(rest[0]);
        if (!f) return reply(chatId, mdt`No skill named ${rest[0]}. Run /skills to list them.`);
        const hit = loadSkillFiles().find((k) => path.join(dir, k.file) === f);
        const head = [
          hit?.when ? `when: ${hit.when}` : null,
          `state: ${hit?.enabled ? 'on' : 'off'}`,
        ].filter(Boolean).join('  ·  ');
        return reply(chatId, [
          bold(hit?.name || path.basename(f)),
          italic(head),
          '',
          agentText(hit?.body || fs.readFileSync(f, 'utf8')),
        ].join('\n'));
      }

      if (sub === 'on' || sub === 'off') {
        const f = fileFor(rest[0]);
        if (!f) return reply(chatId, mdt`No skill named ${rest[0]}.`);
        let raw = fs.readFileSync(f, 'utf8');
        const want = sub === 'on' ? 'true' : 'false';
        if (/^\s*---\r?\n[\s\S]*?\r?\n---/.test(raw)) {
          raw = /^\s*---[\s\S]*?enabled\s*:/m.test(raw)
            ? raw.replace(/(^\s*---[\s\S]*?enabled\s*:\s*)(.*)$/m, `$1${want}`)
            : raw.replace(/^(\s*---\r?\n)/, `$1enabled: ${want}\n`);
        } else {
          raw = `---\nenabled: ${want}\n---\n${raw}`;
        }
        fs.writeFileSync(f, raw);
        agent.reloadSoul?.();
        return reply(chatId, mdt`${sub === 'on' ? '🟢' : '⚪️'} ${path.basename(f)} is now ${sub}. Active from the next prompt.`);
      }

      if (sub === 'add') {
        const joined = rest.join(' ');
        const bar = joined.indexOf('|');
        if (bar < 0) {
          return reply(chatId, mdt`Usage: /skills add <name> | <the skill text>`);
        }
        const name = joined.slice(0, bar).trim();
        const body = joined.slice(bar + 1).trim();
        if (!name || !body) return reply(chatId, mdt`Both a name and a body are required.`);
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill';
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `${slug}.md`);
        fs.writeFileSync(f, `---\nname: ${name}\nenabled: true\n---\n\n${body}\n`);
        agent.reloadSoul?.();
        return reply(chatId, mdt`✅ Saved soul/skills/${slug}.md — the agent knows it from the next message.`);
      }

      if (sub === 'rm' || sub === 'delete') {
        const f = fileFor(rest[0]);
        if (!f) return reply(chatId, mdt`No skill named ${rest[0]}.`);
        fs.unlinkSync(f);
        agent.reloadSoul?.();
        return reply(chatId, mdt`🗑 Deleted ${path.basename(f)}.`);
      }

      return reply(chatId, mdt`Unknown: /skills ${sub}. Use list / show / on / off / add / rm.`);
    },

    /** Re-read soul/ from disk without restarting the process. */
    async reload(chatId) {
      const { skillFiles } = await import('../ai/soul.js').then((m) => m.loadSoul());
      agent.reloadSoul?.();
      const on = (skillFiles || []).filter((k) => k.enabled).length;
      await reply(chatId, mdt`🔄 Reloaded soul/ — ${on} extra skill(s) active.`);
    },

    // --------------------------------------------------------------- memory
    async memory(chatId, args) {
      const mems = args.length
        ? await db.searchMemories(args.join(' '), 15)
        : await db.recall({ limit: 15 });
      if (!mems.length) return reply(chatId, 'Nothing in long\\-term memory yet\\.');
      const lines = [bold('🧠 Long-term memory'), ''];
      for (const m of mems) lines.push(mdt`[${m.kind}${m.subject ? '/' + m.subject : ''}] ${m.content}`);
      await reply(chatId, lines.join('\n'));
    },
  };

  /** Entry point for every incoming Telegram message. */
  return async function handle(msg) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text.startsWith('/')) {
      const [rawCmd, ...args] = text.slice(1).split(/\s+/);
      const name = rawCmd.split('@')[0].toLowerCase();
      const fn = commands[name];
      if (!fn) {
        await reply(chatId, mdt`Unknown command /${name}. Try /help — or just talk to me normally.`);
        return;
      }
      try {
        await fn(chatId, args);
      } catch (e) {
        log.error(`/${name}: ${e.stack || e.message}`);
        await reply(chatId, mdt`❌ /${name} failed: ${e.message}`);
      }
      return;
    }

    // ---- free-form conversation with the agent --------------------------
    await bot.sendTyping(chatId);
    const typing = setInterval(() => bot.sendTyping(chatId), 6000);
    try {
      const r = await agent.run({
        chatId,
        userMessage: text,
        onStep: async ({ type, name, danger }) => {
          // 'thought' steps are the model reasoning out loud on its way to an
          // answer. Keep them out of the chat — the user asked a question, not
          // for a monologue. Only announce actions that move money.
          if (type === 'tool' && danger) await reply(chatId, italic(`⚡ ${name}…`));
        },
      });
      clearInterval(typing);
      await reply(chatId, agentText(r.text || '(no answer)'));
    } catch (e) {
      clearInterval(typing);
      log.error(e.stack || e.message);
      await reply(chatId, mdt`❌ ${e.message}`);
    }
  };
}
