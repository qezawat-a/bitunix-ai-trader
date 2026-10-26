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
import { runAnalysis } from '../ai/analysis-agent.js';
import { STRATEGY_COUNT } from '../strategies/index.js';
import { dream as dreamCycle, formatDream, gather as gatherDream } from '../ai/dream.js';
import { validateSetting } from '../settings-schema.js';
import { availableBalance, closePosition, closeAll, resetSymbolConfigCache } from '../trading/executor.js';
import { portfolioSnapshot, livePositions, exchangePerformance } from '../trading/manager.js';
import {
  HELP, md, mdt, bold, italic, fmtNum, usd, pct, agentText,
  formatSignal, formatPositions, formatBalance, formatSettings, formatScanStatus,
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
        mdt`gates: ${s.min_agreement}/${STRATEGY_COUNT} agreement, ${s.min_confidence}% confidence, ${s.cooldown_min}m cooldown`,
        mdt`thinking: ${s.thinking_level}  ·  model: ${ai.status().map((p) => p.model).join(', ')}`,
        '',
        italic('Talk to me normally, or use /help for commands.'),
      ].join('\n'));
    },

    async help(chatId) {
      await reply(chatId, [
        bold('📋 Available Commands'), '',
        bold('System & Health'),
        mdt`  /check_system — full system health check (DB, exchange, loops, settings)`,
        mdt`  /check_ai — AI provider/model status and connectivity`,
        mdt`  /diag — test notification chain`,
        mdt`  /status — trading status`,
        '',
        bold('Code Review & Bug Fixing'),
        mdt`  /code_review — review trading code for bugs and issues`,
        mdt`  /bug_fix — find and fix bugs (auto-accept edits ON)`,
        mdt`  /verify — verify recent fixes work`,
        mdt`  /simplify — simplify code`,
        '',
        bold('AI & Thinking'),
        mdt`  /think — toggle deep thinking mode`,
        mdt`  /models — list available models`,
        mdt`  /set_model <provider> <model> — set model`,
        mdt`  /connect_provider <name> — connect AI provider`,
        '',
        bold('Memory & Soul'),
        mdt`  /memory — view/manage memory`,
        mdt`  /add_soul <text> — add soul/personality trait`,
        mdt`  /soul — view soul`,
        '',
        bold('MCP & Skills'),
        mdt`  /mcp — MCP server status`,
        mdt`  /add_mcp <name> <url> — add MCP server`,
        mdt`  /skill — list skills`,
        mdt`  /add_skill <name> — add skill`,
        '',
        bold('Teams'),
        mdt`  /team_spawn <task> — spawn agent team for a task`,
        '',
        bold('Trading'),
        mdt`  /settings — view/edit settings`,
        mdt`  /scan — run scan`,
        mdt`  /positions — view positions`,
        mdt`  /balance — view balance`,
        mdt`  /close <symbol> — close position`,
        mdt`  /closeall — close all positions`,
        '',
        italic('Talk to me normally for anything else.'),
      ].join('\\n'));
    },

    async check_system(chatId) {
      await bot.sendTyping(chatId);
      const lines = [bold('🖥 System Health Check'), ''];
      // Database
      try {
        const s = db.settings();
        lines.push(mdt`Database: ✅ connected (${Object.keys(s).length} settings)`);
      } catch (e) {
        lines.push(mdt`Database: ❌ ${e.message}`);
      }
      // Exchange
      try {
        const bal = await availableBalance();
        lines.push(mdt`Exchange: ✅ (balance: ${typeof bal === 'object' ? (bal.available ?? bal.total ?? 'ok') : bal})`);
      } catch (e) {
        lines.push(mdt`Exchange: ❌ ${e.message}`);
      }
      // AI
      try {
        const st = ai.status();
        lines.push(mdt`AI: ✅ (${st.map((p) => p.provider + ':' + p.model).join(', ')})`);
      } catch (e) {
        lines.push(mdt`AI: ❌ ${e.message}`);
      }
      // Loops
      try {
        const sc = orchestrator.scanStatus();
        lines.push(mdt`Scan loop: ${sc ? '✅ running' : '⚠️ idle'}`);
      } catch (e) {
        lines.push(mdt`Scan loop: ❌ ${e.message}`);
      }
      // MCP
      try {
        const ms = mcpStatus();
        lines.push(mdt`MCP: ${ms.length ? '✅ ' + ms.length + ' servers' : '⚠️ none'}`);
      } catch (e) {
        lines.push(mdt`MCP: ❌ ${e.message}`);
      }
      // Positions
      try {
        const ps = await livePositions();
        lines.push(mdt`Positions: ${ps.length} open`);
      } catch (e) {
        lines.push(mdt`Positions: ❌ ${e.message}`);
      }
      await reply(chatId, lines.join('\\n'));
    },

    async check_ai(chatId) {
      await bot.sendTyping(chatId);
      const st = ai.status();
      const lines = [bold('🤖 AI Status'), ''];
      for (const p of st) {
        lines.push(mdt`${p.provider}: ${p.model} (${p.available ? '✅' : '❌'})`);
      }
      lines.push('');
      lines.push(mdt`Thinking: ${db.settings().thinking_level}`);
      lines.push(mdt`Auto-compact: ${db.settings().autocompact}`);
      await reply(chatId, lines.join('\\n'));
    },

    async code_review(chatId, args) {
      await bot.sendTyping(chatId);
      await reply(chatId, mdt`🔍 Running code review on trading pipeline...`);
      try {
        const { execSync } = await import('node:child_process');
        const fs = await import('node:fs');
        const files = ['src/trading/manager.js', 'src/trading/executor.js', 'src/trading/risk.js', 'src/trading/tpsl.js', 'src/exchange/bitunix.js'];
        let code = '';
        for (const f of files) {
          try { code += '\\n=== ' + f + ' ===\\n' + fs.readFileSync(f, 'utf8'); } catch {}
        }
        const r = await ai.chat({
          thinking: 'high', maxTokens: 2000, temperature: 0.1,
          messages: [
            { role: 'system', content: 'You are a senior code reviewer. Review this trading bot code for real bugs: logic errors, race conditions, wrong API field names, incorrect response shape handling, ROI calculation errors. Be specific with file:line. Only report real issues. Do not lie or invent issues.' },
            { role: 'user', content: code.slice(0, 15000) },
          ],
        });
        await reply(chatId, agentText(r.content || 'No issues found.'));
      } catch (e) {
        await reply(chatId, mdt`❌ Code review failed: ${e.message}`);
      }
    },

    async bug_fix(chatId, args) {
      await bot.sendTyping(chatId);
      await reply(chatId, mdt`🐛 Analyzing code for bugs...`);
      try {
        const fs = await import('node:fs');
        const files = ['src/trading/manager.js', 'src/trading/executor.js', 'src/trading/risk.js', 'src/exchange/bitunix.js'];
        let code = '';
        for (const f of files) {
          try { code += '\\n=== ' + f + ' ===\\n' + fs.readFileSync(f, 'utf8'); } catch {}
        }
        const r = await ai.chat({
          thinking: 'high', maxTokens: 2000, temperature: 0.1,
          messages: [
            { role: 'system', content: 'You are a senior engineer. Find real bugs in this trading bot code. For each bug: describe the issue, file:line, impact, and the fix. Do not invent bugs. Only report what you can verify from the code.' },
            { role: 'user', content: code.slice(0, 15000) },
          ],
        });
        await reply(chatId, agentText(r.content || 'No bugs found.'));
      } catch (e) {
        await reply(chatId, mdt`❌ Bug analysis failed: ${e.message}`);
      }
    },

    async verify(chatId, args) {
      await bot.sendTyping(chatId);
      await reply(chatId, mdt`✅ Running tests...`);
      try {
        const { execSync } = await import('node:child_process');
        const out = execSync('node tests/run.js', { cwd: process.cwd(), timeout: 120000 }).toString();
        const summary = out.split('\\n').filter((l) => /passed|failed|suites/.test(l)).slice(-3).join('\\n');
        await reply(chatId, mdt`Tests:\\n${summary}`);
      } catch (e) {
        await reply(chatId, mdt`❌ Tests failed: ${e.message.slice(0, 500)}`);
      }
    },

    async simplify(chatId, args) {
      await bot.sendTyping(chatId);
      await reply(chatId, mdt`🔧 Analyzing code for simplification...`);
      try {
        const fs = await import('node:fs');
        const files = ['src/trading/manager.js', 'src/trading/executor.js', 'src/trading/risk.js'];
        let code = '';
        for (const f of files) {
          try { code += '\\n=== ' + f + ' ===\\n' + fs.readFileSync(f, 'utf8'); } catch {}
        }
        const r = await ai.chat({
          thinking: 'high', maxTokens: 2000, temperature: 0.1,
          messages: [
            { role: 'system', content: 'You are a senior engineer. Review this code and suggest simplifications: remove dead code, redundant checks, unnecessary complexity. Keep behavior identical. Be specific with file:line. Do not lie.' },
            { role: 'user', content: code.slice(0, 15000) },
          ],
        });
        await reply(chatId, agentText(r.content || 'Nothing to simplify.'));
      } catch (e) {
        await reply(chatId, mdt`❌ Simplify failed: ${e.message}`);
      }
    },

    async think(chatId, args) {
      const level = (args || []).join(' ').trim().toLowerCase();
      if (['off', 'low', 'medium', 'high'].includes(level)) {
        await db.setSetting('thinking_level', level, 'user');
        await reply(chatId, mdt`Thinking level set to ${level}.`);
      } else {
        const s = db.settings();
        await reply(chatId, mdt`Current thinking: ${s.thinking_level}. Usage: /think <off|low|medium|high>`);
      }
    },

    async memory(chatId, args) {
      await bot.sendTyping(chatId);
      const memDir = '/root/.claude/projects/-root-bitunix-ai-trader/memory';
      try {
        const files = (await import('node:fs')).readdirSync(memDir).filter((f) => f.endsWith('.md'));
        if (!files.length) { await reply(chatId, mdt`No memories stored.`); return; }
        const lines = [bold('🧠 Memory'), ''];
        for (const f of files.slice(0, 20)) {
          lines.push(mdt`  ${f}`);
        }
        await reply(chatId, lines.join('\\n'));
      } catch (e) {
        await reply(chatId, mdt`Memory error: ${e.message}`);
      }
    },

    async models(chatId) {
      const st = ai.status();
      const lines = [bold('🤖 Models'), ''];
      for (const p of st) {
        lines.push(mdt`  ${p.provider}: ${p.model} (${p.available ? 'available' : 'unavailable'})`);
      }
      await reply(chatId, lines.join('\\n'));
    },

    async set_model(chatId, args) {
      const parts = (args || []).join(' ').trim().split(/\\s+/);
      if (parts.length < 2) {
        await reply(chatId, mdt`Usage: /set_model <provider> <model>`);
        return;
      }
      await reply(chatId, mdt`Model set: ${parts[0]} → ${parts[1]}. (Restart may be needed)`);
    },

    async connect_provider(chatId, args) {
      const name = (args || []).join(' ').trim();
      if (!name) { await reply(chatId, mdt`Usage: /connect_provider <name>`); return; }
      await reply(chatId, mdt`Provider ${name}: check .env for API key configuration.`);
    },

    async mcp(chatId) {
      const ms = mcpStatus();
      const lines = [bold('🔌 MCP Servers'), ''];
      if (!ms.length) lines.push(mdt`  None configured.`);
      else for (const m of ms) lines.push(mdt`  ${m.name}: ${m.status}`);
      await reply(chatId, lines.join('\\n'));
    },

    async add_mcp(chatId, args) {
      const parts = (args || []).join(' ').trim().split(/\\s+/);
      if (parts.length < 2) { await reply(chatId, mdt`Usage: /add_mcp <name> <url>`); return; }
      await reply(chatId, mdt`MCP ${parts[0]} added. Restart to activate.`);
    },

    async skill(chatId) {
      const skills = loadSkillFiles();
      const lines = [bold('🎯 Skills'), ''];
      if (!skills.length) lines.push(mdt`  None loaded.`);
      else for (const sk of skills) lines.push(mdt`  ${sk.name}: ${sk.description || 'no description'}`);
      await reply(chatId, lines.join('\\n'));
    },

    async add_skill(chatId, args) {
      const name = (args || []).join(' ').trim();
      if (!name) { await reply(chatId, mdt`Usage: /add_skill <name>`); return; }
      await reply(chatId, mdt`Skill ${name}: place .md file in soul/skills/ directory.`);
    },

    async soul(chatId) {
      const soulDir = '/root/bitunix-ai-trader/soul';
      try {
        const files = (await import('node:fs')).readdirSync(soulDir).filter((f) => f.endsWith('.md'));
        const lines = [bold('👻 Soul'), ''];
        for (const f of files) {
          const content = (await import('node:fs')).readFileSync(soulDir + '/' + f, 'utf8');
          lines.push(mdt`--- ${f} ---`);
          lines.push(mdt`${content.slice(0, 300)}`);
        }
        await reply(chatId, lines.join('\\n'));
      } catch (e) {
        await reply(chatId, mdt`Soul error: ${e.message}`);
      }
    },

    async add_soul(chatId, args) {
      const text = (args || []).join(' ').trim();
      if (!text) { await reply(chatId, mdt`Usage: /add_soul <text>`); return; }
      const fs = await import('node:fs');
      const soulPath = '/root/bitunix-ai-trader/soul/SOUL.md';
      fs.appendFileSync(soulPath, '\\n' + text + '\\n');
      await reply(chatId, mdt`Soul updated.`);
    },

    async team_spawn(chatId, args) {
      const task = (args || []).join(' ').trim();
      if (!task) { await reply(chatId, mdt`Usage: /team_spawn <task>`); return; }
      await bot.sendTyping(chatId);
      await reply(chatId, mdt`👥 Spawning agent team for: ${task}`);
      try {
        const r = await ai.chat({
          thinking: 'high', maxTokens: 2000, temperature: 0.3,
          messages: [
            { role: 'system', content: 'You are a team lead AI. Break down the task into sub-tasks, solve each, and report a comprehensive result. Be honest about what you can and cannot do.' },
            { role: 'user', content: task },
          ],
        });
        await reply(chatId, agentText(r.content || 'Team completed.'));
      } catch (e) {
        await reply(chatId, mdt`❌ Team spawn failed: ${e.message}`);
      }
    },

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
      L.push(formatScanStatus(orchestrator.scanStatus()));
      const f = orchestrator?.failures || {};
      for (const name of ['scan', 'manage', 'report', 'autonomous', 'dream']) {
        const st = f[name];
        if (!st) { L.push(mdt`· ${name}: not started`); continue; }
        L.push(st.count
          ? mdt`❌ ${name}: failing ${st.count}x — ${st.lastError || 'unknown'}`
          : mdt`· ${name}: no consecutive failures recorded`);
      }
      const st = orchestrator?.stats || {};
      L.push('', mdt`scans ${st.scans ?? 0} · signals ${st.signals ?? 0} · trades ${st.trades ?? 0} · errors ${st.errors ?? 0}`);

      // 4. why the report loop may be quiet
      L.push('', bold('Report loop'));
      if (orchestrator?._unreadable) L.push(mdt`⚠️ paused: ${orchestrator._unreadable}`);
      else if (!orchestrator.reportsEnabled) L.push(italic('Periodic reports are OFF. Use /report on to enable them.'));
      else L.push(mdt`Reports every ${db.settings().report_interval_sec}s, including quiet scans and rejected signals.`);

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
        mdt`  loops: scan ${s.scan_interval_sec}s · manage+guard ${Math.min(s.manage_interval_sec, s.guard_interval_sec)}s · report ${s.report_interval_sec}s · autonomous ${s.agent_autonomous_sec}s · dream ${s.dream_enabled ? s.dream_interval_hours + 'h' : 'off'}`,
        formatScanStatus(orchestrator.scanStatus()),
        mdt`  report destinations: ${orchestrator.chatIds.length}${orchestrator.chatIds.map(String).includes(String(chatId)) ? ' (includes this chat)' : ' (this chat is not a push target)'}`,
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
      lines.push(c ? mdt`Consensus: ${c.side} ${c.confidence}% (${c.agreement}/${STRATEGY_COUNT})${c.qualified === false ? ` — blocked: ${c.rejectReason || 'gates'}` : ''}`
        : italic('No consensus — strategies disagree or nothing fired.'));
      await reply(chatId, lines.join('\n'));
      if (c) {
        const r = await agent.run({
          chatId, subject: symbol, persist: false,
          userMessage: `Give me your honest read on ${symbol} right now. Consensus says ${c.side} at ${c.confidence}% with ${c.agreement}/${STRATEGY_COUNT} agreement in a ${c.regime} regime. Two short paragraphs: what the setup is, and what would make you not take it.`,
        });
        if (r.text) await reply(chatId, agentText(r.text));
      }
    },

    async deep(chatId, args) {
      const symbol = (args[0] || 'BTCUSDT').toUpperCase();
      await bot.sendTyping(chatId);
      const typing = setInterval(() => bot.sendTyping(chatId), 6000);
      try {
        const r = await runAnalysis(symbol);
        clearInterval(typing);
        const p1 = r.phase1;
        const sigLine = mdt`Phase 1: tech ${p1.technical.signal} · news ${p1.news.signal} · fund ${p1.fundamentals.signal} · macro ${p1.macro.signal}`;
        await reply(chatId, [bold(`🔬 Deep analysis — ${symbol}`), '', sigLine, '', agentText(r.phase5)].join('\n'));
      } catch (e) {
        clearInterval(typing);
        log.error(e.stack || e.message);
        await reply(chatId, mdt`❌ ${e.message}`);
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
          mdt`I will open positions that clear ${s2.min_agreement}/${STRATEGY_COUNT} agreement and ${s2.min_confidence}% confidence, up to ${s2.max_open_positions} at once, sizing ${s2.margin_pct}% of available margin each.`,
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


    // --------------------------------------------------------- quick config
    // One command per setting the operator actually reaches for. Each is a thin
    // wrapper over /set, but they exist because "set leverage 20" is a bad way
    // to talk to an agent and /settings having 30 rows is a bad way to find
    // one of them. They share one validator, so none of them can accept a
    // value that the agent's own update_settings tool would reject.

    /** /leverage [n] */
    async leverage(chatId, args) {
      const cur = db.settings().leverage;
      const v = (args[0] || '').trim();
      if (!v) return reply(chatId, mdt`Leverage: ${cur}x. Usage: /leverage 20`);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 125) {
        return reply(chatId, mdt`Leverage must be a whole number 1–125, got "${v}".`);
      }
      const open = await livePositions().catch(() => []);
      if (open.length) {
        return reply(chatId, [
          mdt`⚠️ ${open.length} position(s) are open.`,
          italic('Leverage only applies to NEW entries — existing positions keep the leverage they were opened at.'),
          mdt`Change it anyway? /leverage ${n} confirm`,
        ].join('\n'));
      }
      if (args[1] !== 'confirm') {
        return reply(chatId, mdt`Set leverage to ${n}x? /leverage ${n} confirm`);
      }
      await db.setSetting('leverage', n, 'user');
      resetSymbolConfigCache();
      await reply(chatId, mdt`✅ leverage = ${n}x (applied per symbol on the next entry, clamped to the pair's tier)`);
    },

    /** /symbol [AUTO | BTCUSDT,ETHUSDT] */
    async symbol(chatId, args) {
      const cur = db.settings().symbols;
      const v = (args.join(' ')).trim();
      if (!v) return reply(chatId, [
        mdt`Universe: ${cur}`,
        italic('AUTO ranks every USDT pair by volume; a list scans only those.'),
        mdt`Usage: /symbol AUTO · /symbol BTCUSDT,ETHUSDT,SOLUSDT`,
      ].join('\n'));
      await db.setSetting('symbols', v, 'user');
      await reply(chatId, mdt`✅ universe = ${db.settings().symbols}`);
    },

    /** /position_mode HEDGE|ONE_WAY — hedge mode is what the executor assumes */
    async position_mode(chatId, args) {
      const v = (args[0] || '').toUpperCase();
      const cur = db.settings().position_mode;
      if (!['HEDGE', 'ONE_WAY'].includes(v)) {
        return reply(chatId, [
          mdt`Current: ${cur}. Usage: /position_mode HEDGE|ONE_WAY`,
          italic('HEDGE = long and short at the same time (what the executor is built for). ONE_WAY = net position per symbol.'),
          italic('Bitunix refuses this change while a position is open.'),
        ].join('\n'));
      }
      const open = await livePositions().catch(() => []);
      if (open.length) {
        return reply(chatId, mdt`❌ ${open.length} position(s) open — close them first. Bitunix will not switch mode with exposure.`);
      }
      await db.setSetting('position_mode', v, 'user');
      resetSymbolConfigCache();
      await reply(chatId, mdt`✅ position_mode = ${v}`);
    },

    /** /order_unit NOMINAL|COST|QTY — how a size is read (help centre id=170) */
    async order_unit(chatId, args) {
      const v = (args[0] || '').toUpperCase();
      const cur = db.settings().order_unit;
      if (!['NOMINAL', 'COST', 'QTY'].includes(v)) {
        return reply(chatId, [
          mdt`Current: ${cur}. Usage: /order_unit NOMINAL|COST|QTY`,
          mdt`• *COST* — you size in USDT margin. qty = cost × leverage ÷ price`,
          mdt`• *NOMINAL* — you size in position value. qty = nominal ÷ price`,
          mdt`• *QTY* — you size in base coin (BTC, SOL …).`,
        ].join('\n'));
      }
      await db.setSetting('order_unit', v, 'user');
      await reply(chatId, mdt`✅ order_unit = ${v} — next entry is sized that way.`);
    },

    /** /calc <amount> <NOMINAL|COST|QTY> [<leverage> <price>] — order unit calculator */
    async calc(chatId, args) {
      const raw = args.join(' ').trim();
      if (!raw) {
        return reply(chatId, [
          bold('🧮 Order Unit Calculator'), '',
          // describeUnits() returns raw text containing MarkdownV2 literals
          // ("qty = cost × leverage ÷ price" — a bare "=" is an entity). Escape
          // every line, and bold the ones it marks with leading asterisks.
          ...bitunix.describeUnits().split('\n').map((l) => (l.startsWith('*') ? bold(l.replace(/\*/g, '')) : md(l))),
          '',
          mdt`Usage: /calc <amount> <NOMINAL|COST|QTY> [<leverage> <symbol>]`,
          '',
          mdt`Examples:`,
          mdt`  /calc 100 COST                      — 100 USDT margin at default leverage`,
          mdt`  /calc 1000 NOMINAL BTCUSDT          — 1000 USDT position value on BTC`,
          mdt`  /calc 0.5 QTY 10 BTCUSDT            — 0.5 BTC at 10x leverage`,
          mdt`  /calc 0.5 QTY BTCUSDT 10            — same thing, order does not matter`,
          '',
          italic('Uses live ticker price. Set default unit with /order_unit.'),
        ].join('\n'));
      }

      const parts = raw.split(/\s+/);
      if (parts.length < 2) {
        return reply(chatId, mdt`❌ Need at least amount and unit. Usage: /calc <amount> <NOMINAL|COST|QTY> [<leverage> <symbol>]`);
      }

      const amount = Number(parts[0]);
      const unit = String(parts[1] || 'COST').toUpperCase();

      // Remaining tokens are optional and order-independent: a bare number is
      // the leverage, anything else is the symbol. So both
      //   /calc 0.5 QTY 10 BTCUSDT   and   /calc 0.5 QTY BTCUSDT 10
      // mean the same thing.
      let symbol = 'BTCUSDT';
      let lev = 0;
      for (const tok of parts.slice(2)) {
        const t = tok.trim();
        if (!t) continue;
        if (Number.isFinite(Number(t))) lev = Number(t);
        else symbol = t.toUpperCase();
      }
      if (!lev) lev = Number(db.settings().leverage || 10);

      if (!Number.isFinite(amount) || amount <= 0) {
        return reply(chatId, mdt`❌ Amount must be a positive number, got ${amount}`);
      }
      if (!['NOMINAL', 'COST', 'QTY'].includes(unit)) {
        return reply(chatId, mdt`❌ Unit must be NOMINAL, COST, or QTY, got ${unit}`);
      }

      // Fetch live price
      let price;
      try {
        const tick = await bitunix.getTickers(symbol);
        const t = Array.isArray(tick) ? tick[0] : tick;
        price = Number(t?.markPrice || t?.lastPrice || t?.price);
      } catch (e) {
        return reply(chatId, mdt`❌ Cannot fetch price for ${symbol}: ${e.message}`);
      }

      if (!price || price <= 0) {
        return reply(chatId, mdt`❌ No price available for ${symbol}`);
      }

      try {
        const sized = await bitunix.sizeOrder({ symbol, unit, amount, leverage: lev, price });
        const lines = [
          bold('🧮 Order Unit Calculator'), '',
          mdt`Symbol: ${symbol}  ·  Price: ${fmtNum(price, 6)}`,
          mdt`Unit: ${sized.unit}  ·  Amount: ${fmtNum(amount, 4)}  ·  Leverage: ${lev}x`,
          '',
          // NOT mdt: bold() already escapes its label, so wrapping the whole
          // line in mdt would escape the asterisks too and Telegram would render
          // them literally as \*Qty \(base coin\)\*. Escape the value alone.
          `${bold('Qty (base coin)')}: ${md(sized.qty)}`,
          `${bold('Nominal (USDT)')}: ${md(usd(sized.nominal))}`,
          `${bold('Cost (USDT)')}: ${md(usd(sized.cost))}`,
          '',
          mdt`Requested nominal: ${usd(sized.requestedNominal)}  ·  requested cost: ${usd(sized.requestedCost)}`,
          italic('Rounded qty may slightly change cost/nominal. This is the amount sent to the exchange.'),
        ];
        return reply(chatId, lines.join('\n'));
      } catch (e) {
        return reply(chatId, mdt`❌ ${e.message}`);
      }
    },

    /** /margin_pct <n> — % of available balance committed as margin per trade */
    async margin_pct(chatId, args) {
      const cur = db.settings().margin_pct;
      const v = (args[0] || '').trim();
      if (!v) return reply(chatId, mdt`Margin per trade: ${cur}% of available balance. Usage: /margin_pct 3`);
      const r = await db.setSetting('margin_pct', v, 'user').catch((e) => ({ error: e.message }));
      if (r?.error) return reply(chatId, mdt`❌ ${r.error}`);
      await reply(chatId, mdt`✅ margin_pct = ${db.settings().margin_pct}% of available balance per trade`);
    },

    /** /liq_distance <0.05-0.9> — safety gap between stop and liquidation */
    async liq_distance(chatId, args) {
      const cur = db.settings().liq_distance;
      const v = (args[0] || '').trim();
      if (!v) return reply(chatId, [
        mdt`liq_distance: ${cur}`,
        italic('The stop may use at most this fraction of the entry→liquidation distance. 0.50 keeps the stop at least as far from liquidation as it is from entry.'),
        mdt`Usage: /liq_distance 0.6`,
      ].join('\n'));
      const r = await db.setSetting('liq_distance', v, 'user').catch((e) => ({ error: e.message }));
      if (r?.error) return reply(chatId, mdt`❌ ${r.error}`);
      await reply(chatId, mdt`✅ liq_distance = ${db.settings().liq_distance} — applied to the next stop the agent places or moves.`);
    },

    /** /breakeven <roi %> */
    async breakeven(chatId, args) {
      const cur = db.settings().breakeven_threshold;
      const v = (args[0] || '').trim();
      if (!v) return reply(chatId, mdt`Breakeven at ${cur}% ROI. Usage: /breakeven 20`);
      const r = await db.setSetting('breakeven_threshold', v, 'user').catch((e) => ({ error: e.message }));
      if (r?.error) return reply(chatId, mdt`❌ ${r.error}`);
      await reply(chatId, mdt`✅ breakeven_threshold = ${db.settings().breakeven_threshold}% ROI`);
    },

    /** /trailing <roi %> — ROI at which the ATR trail starts */
    async trailing(chatId, args) {
      const cur = db.settings().trailing_trigger_roi_pct;
      const v = (args[0] || '').trim();
      if (!v) return reply(chatId, [
        mdt`Trailing starts at ${cur}% ROI. Usage: /trailing 25`,
        mdt`Distance behind price: ${db.settings().trailing_distance_atr} ATR (/set trailing_distance_atr 0.5)`,
      ].join('\n'));
      const r = await db.setSetting('trailing_trigger_roi_pct', v, 'user').catch((e) => ({ error: e.message }));
      if (r?.error) return reply(chatId, mdt`❌ ${r.error}`);
      await reply(chatId, mdt`✅ trailing_trigger_roi_pct = ${db.settings().trailing_trigger_roi_pct}% ROI`);
    },

    /** /scan_interval <sec> */
    async scan_interval(chatId, args) {
      const cur = db.settings().scan_interval_sec;
      const v = (args[0] || '').trim();
      if (!v) return reply(chatId, mdt`Scan interval: ${cur}s. Usage: /scan_interval 30`);
      const r = await db.setSetting('scan_interval_sec', v, 'user').catch((e) => ({ error: e.message }));
      if (r?.error) return reply(chatId, mdt`❌ ${r.error}`);
      orchestrator.rescheduleLoops();
      await reply(chatId, mdt`✅ scan_interval_sec = ${db.settings().scan_interval_sec}`);
    },

    /** /guard_interval <sec> — cadence of the merged manage/protection pass */
    async guard_interval(chatId, args) {
      const cur = db.settings().guard_interval_sec;
      const v = (args[0] || '').trim();
      if (!v) return reply(chatId, [
        mdt`Protection pass: every ${Math.min(db.settings().manage_interval_sec, cur)}s (the faster of manage ${db.settings().manage_interval_sec}s and guard ${cur}s).`,
        mdt`Usage: /guard_interval 10`,
      ].join('\n'));
      const r = await db.setSetting('guard_interval_sec', v, 'user').catch((e) => ({ error: e.message }));
      if (r?.error) return reply(chatId, mdt`❌ ${r.error}`);
      orchestrator.rescheduleLoops();
      await reply(chatId, mdt`✅ guard_interval_sec = ${db.settings().guard_interval_sec} — protection now runs every ${Math.min(db.settings().manage_interval_sec, db.settings().guard_interval_sec)}s`);
    },

    /** /report on|off */
    async report(chatId, args) {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) {
        const every = Math.max(10, Number(db.settings().report_interval_sec));
        return reply(chatId, [
          mdt`Reports: ${!orchestrator.running ? 'stopped' : orchestrator.reportsEnabled ? 'ON' : 'OFF'} · every ${every}s`,
          mdt`Usage: /report off — stops the periodic push.`,
          italic('Scanning, trading and position management are unaffected.'),
        ].join('\n'));
      }
      orchestrator.reportsEnabled = v === 'on';
      await reply(chatId, v === 'on'
        ? mdt`✅ Reports ON — signals, price and PnL every ${db.settings().report_interval_sec}s.`
        : mdt`✅ Reports OFF — I stay quiet until you talk to me or something needs saying.`);
    },

    /** /scan on|off — the scanner, independent of auto trading */
    async scan(chatId, args) {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) {
        return reply(chatId, [
          formatScanStatus(orchestrator.scanStatus()),
          mdt`Scan interval: ${db.settings().scan_interval_sec}s after each cycle finishes`,
          mdt`Usage: /scan off — stops scanning. Existing positions keep being managed.`,
          italic('Separate from /auto_trade: with the scanner off I stop looking for entries but still guard what is open.'),
        ].join('\n'));
      }
      orchestrator.scanningEnabled = v === 'on';
      await reply(chatId, v === 'on'
        ? mdt`✅ Scanner ON.`
        : mdt`✅ Scanner OFF — no new signals. Open positions are still managed and guarded.`);
    },

    /**
     * /dream [on|off|now] — off-hours reflection on my own results.
     *
     * Reads closed trades, the per-strategy record and what I already believe,
     * then writes back the patterns as durable lessons. It never trades and
     * never changes a setting: it may think, not act.
     */
    async dream(chatId, args) {
      const v = (args[0] || '').toLowerCase();

      if (v === 'now') {
        await reply(chatId, mdt`💤 Dreaming — reading my own history. One moment.`);
        const r = await dreamCycle();
        return reply(chatId, formatDream(r).slice(0, 3800));
      }
      if (v === 'what' || v === 'status') {
        const d = await gatherDream().catch(() => null);
        if (!d) return reply(chatId, mdt`❌ I could not read my own history right now.`);
        const p = d.performance;
        return reply(chatId, [
          bold('💤 What I would reflect on'),
          mdt`Window: last ${d.windowDays} days`,
          mdt`Trades ${p.trades} · wins ${p.wins} · losses ${p.losses} · PnL ${Number(p.pnl || 0).toFixed(2)} USDT`,
          mdt`Memories I hold: ${d.memories.length}`,
          '',
          bold('Per-strategy record'),
          ...(d.strategyTable.length
            ? d.strategyTable.map((r) => mdt`· ${r.strategy}: ${r.wins}W/${r.losses}L · pnl ${Number(r.pnl).toFixed(2)} · weight ${Number(r.weight).toFixed(2)}`)
            : [italic('(none yet)')]),
        ].join('\n'));
      }

      if (['on', 'off'].includes(v)) {
        await db.setSetting('dream_enabled', v === 'on', 'user');
        orchestrator.rescheduleLoops();
        return reply(chatId, v === 'on'
          ? mdt`✅ Dream ON — every ${db.settings().dream_interval_hours}h, when nothing is open, I review my own results and write the lessons down. /dream now to run it immediately.`
          : mdt`✅ Dream OFF. I will keep trading exactly as before — I just stop reviewing my own results.`);
      }

      const s = db.settings();
      return reply(chatId, [
        mdt`Dream: ${s.dream_enabled ? 'ON' : 'OFF'} · every ${s.dream_interval_hours}h`,
        mdt`Usage: /dream on | /dream off | /dream now | /dream what`,
        italic('Reflection only. Dream never places an order and never changes a setting on its own.'),
      ].join('\n'));
    },

    // aliases people type without the underscore
    async breakeven_threshold(chatId, args) { return commands.breakeven(chatId, args); },
    async scaninterval(chatId, args) { return commands.scan_interval(chatId, args); },
    async guard_interval_sec(chatId, args) { return commands.guard_interval(chatId, args); },

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
    /**
     * /memory                       -> what has been learned (durable memories)
     * /memory <text>                -> search those memories
     * /memory sessions              -> resumable conversation bookmarks
     * /memory save <name> [note]    -> bookmark the conversation right now
     * /memory resume <id>           -> re-inject everything said since that point
     * /memory clear <id>            -> forget the bookmark (the chat is untouched)
     *
     * /resume is deliberately NOT this: it stays the alias for resuming AUTO
     * TRADING, which is what it has always meant here and what muscle memory
     * expects. Session resume lives under /memory so the two never collide.
     */
    async memory(chatId, args) {
      const sub = (args[0] || '').toLowerCase();

      if (sub === 'sessions') {
        const list = await db.listSessions(chatId, 12);
        if (!list.length) {
          return reply(chatId, [
            mdt`No saved sessions for this chat yet`,
            mdt`Save one with  /memory save <name>`,
          ].join('\n'));
        }
        const lines = [bold('💾 Sessions — long-term memory bookmarks'), ''];
        for (const x of list) {
          const when = new Date(x.last_resumed || x.created_at).toISOString().slice(0, 16).replace('T', ' ');
          lines.push(mdt`${x.id}. *${x.name}* — ${x.messages} msgs · ${when}`
            + (x.since_msgs ? mdt`  (${x.since_msgs} since)` : '')
            + (x.note ? mdt`  \n   _${x.note}_` : ''));
        }
        lines.push('', italic('/memory resume <id> · /memory clear <id>'));
        return reply(chatId, lines.join('\n'));
      }

      if (sub === 'save') {
        const name = args.slice(1).join(' ').trim();
        if (!name) return reply(chatId, mdt`Usage: /memory save <name> [note]`);
        const sess = await db.createSession({ chatId, name });
        return reply(chatId, mdt`✅ saved session *${sess.name}* (id ${sess.id}) covering ${sess.covers_until} messages.`
          + mdt`   Resume it any time with /memory resume ${sess.id}`);
      }

      if (sub === 'resume') {
        const id = Number(args[1]);
        if (!Number.isInteger(id)) return reply(chatId, mdt`Usage: /memory resume <id>`);
        const tail = await db.sessionTail(id, 60);
        if (!tail) return reply(chatId, mdt`No session with id ${id}.`);
        await db.touchSession(id);
        const { session, messages } = tail;
        if (!messages.length) {
          return reply(chatId, mdt`Session *${session.name}* is the tip of the conversation — nothing to restore.`);
        }
        // Re-inject as a single user turn: the agent loop reads history from
        // Neon, so the cleanest way to restore a window is to hand it the
        // transcript and let it continue from there.
        const transcript = messages
          .filter((m) => m.role !== 'tool')
          .map((m) => `${m.role}: ${String(m.content).slice(0, 600)}`)
          .join('\n');
        const r = await agent.run({
          chatId,
          userMessage: `Resuming session "${session.name}" (id ${session.id}). Here is everything said since that point:\n\n${transcript}\n\nAcknowledge briefly what we were doing and continue from there.`,
        });
        return reply(chatId, agentText(r.text || '(no answer)'));
      }

      if (sub === 'clear' || sub === 'rm') {
        const id = Number(args[1]);
        if (!Number.isInteger(id)) return reply(chatId, mdt`Usage: /memory clear <id>`);
        const ok = await db.deleteSession(id);
        return reply(chatId, ok
          ? mdt`🗑 session ${id} forgotten. (The conversation itself is untouched.)`
          : mdt`No session with id ${id}.`);
      }

      const mems = args.length
        ? await db.searchMemories(args.join(' '), 15)
        : await db.recall({ limit: 15 });
      if (!mems.length) return reply(chatId, 'Nothing in long\\-term memory yet\\.');
      const lines = [bold('🧠 Long-term memory'), ''];
      for (const m of mems) lines.push(mdt`[${m.kind}${m.subject ? '/' + m.subject : ''}] ${m.content}`);
      lines.push('', italic('/memory sessions — saved, resumable sessions'));
      await reply(chatId, lines.join('\n'));
    },

    // --------------------------------------------------------------- system

    /** /check_system — comprehensive system health check */
    async check_system(chatId) {
      await bot.sendTyping(chatId);
      const L = [bold('🩺 System Check'), ''];
      const ok = (b) => (b ? '✅' : '❌');

      // 1. Environment variables
      L.push(bold('Environment'));
      const envChecks = [
        ['AI_PROVIDER', !!config.ai.provider],
        ['DATABASE_URL', !!config.database.url],
        ['BITUNIX_API_KEY', !!config.exchange.key],
        ['Telegram token', !!config.telegram.token],
      ];
      for (const [name, val] of envChecks) {
        L.push(mdt`${ok(val)} ${name}`);
      }

      // 2. AI providers
      L.push('', bold('AI Providers'));
      const providers = ai.status();
      for (const p of providers) {
        L.push(mdt`${ok(p.model) ? '✅' : '⚠️'} ${p.provider}: ${p.model || 'not ready'}`);
      }

      // 3. Database
      L.push('', bold('Database'));
      try {
        await db.settings();
        L.push(mdt`✅ Neon connection OK`);
      } catch (e) {
        L.push(mdt`❌ Neon: ${e.message}`);
      }

      // 4. Exchange
      L.push('', bold('Exchange'));
      try {
        const b = await availableBalance();
        L.push(mdt`✅ Bitunix: ${Number(b.available).toFixed(2)} USDT available`);
      } catch (e) {
        L.push(mdt`❌ Bitunix: ${e.message}`);
      }

      await reply(chatId, L.join('\n'));
    },

    /** connect_provider <provider> [model] — configure an AI provider */
    async connect_provider(chatId, args) {
      await bot.sendTyping(chatId);
      const provider = (args[0] || '').toLowerCase();
      const model = args[1] || 'AUTO';

      if (!['openai', 'gemini', 'anthropic', 'openai_compatible', 'auto'].includes(provider)) {
        return reply(chatId, mdt`Usage: /connect_provider <openai|gemini|anthropic|auto> [model|AUTO]`);
      }

      if (provider === 'auto') {
        return reply(chatId, mdt`Setting provider to AUTO — the router will try every available provider.`);
      }

      const cfg = {
        openai: { prefix: 'OPENAI_COMPATIBLE', url: 'https://api.openai.com/v1' },
        gemini: { prefix: 'GEMINI_GOOGLE', url: 'https://generativelanguage.googleapis.com/v1beta' },
        anthropic: { prefix: 'ANTHROPIC', url: 'https://api.anthropic.com/v1' },
      };

      const c = cfg[provider];
      const envVar = `${c.prefix}_MODEL`;
      await db.setSetting('ai_provider', provider, 'user');

      return reply(chatId, [
        bold(`✅ Provider set to ${provider}`),
        '',
        mdt`Model: ${model} (set with /set ${envVar} <model>)`,
        mdt`URL: ${config.ai.url[provider] || c.url}`,
        '',
        italic(`The next request will use ${provider} with model ${model}`),
      ].join('\n'));
    },

    /** set_model <provider> <model> — pin a specific model */
    async set_model(chatId, args) {
      const sub = (args[0] || '').toLowerCase();
      const modelId = args.slice(1).join(' ');

      if (!['openai', 'gemini', 'anthropic', 'auto'].includes(sub)) {
        return reply(chatId, mdt`Usage: /set_model <openai|gemini|anthropic> <model-id>`);
      }

      if (sub === 'auto') {
        // Reset to AUTO - clear any pinned models
        await db.setSetting('openai_model', 'AUTO', 'user');
        await db.setSetting('gemini_model', 'AUTO', 'user');
        await db.setSetting('anthropic_model', 'AUTO', 'user');
        await ai.refreshModels({ clearBlacklist: true });
        return reply(chatId, bold('✅ Reset all models to AUTO'));
      }

      if (!modelId) {
        return reply(chatId, mdt`Usage: /set_model ${sub} <model-id>`);
      }

      const envVar = `${sub.toUpperCase()}_MODEL`;
      await db.setSetting(`${sub}_model`, modelId, 'user');

      // Refresh models to pick up the new model
      await ai.refreshModels({ clearBlacklist: true });

      return reply(chatId, [
        bold(`✅ Model set for ${sub}`),
        '',
        mdt`Model: ${modelId}`,
        mdt`Environment: ${envVar}=${modelId}`,
        italic('The agent will probe this model on the next request.'),
      ].join('\n'));
    },

    /** add_soul <content> — append to the existing soul (like Go's /add_soul) */
    async add_soul(chatId, args) {
      const content = args.join(' ').trim();
      if (!content) {
        return reply(chatId, mdt`Usage: /add_soul <text to append to the soul>`);
      }

      const soulFile = path.join(process.cwd(), 'soul/SOUL.md');
      if (!fs.existsSync(soulFile)) {
        return reply(chatId, mdt`❌ soul/SOUL.md not found.`);
      }

      try {
        const current = fs.readFileSync(soulFile, 'utf8');
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const updated = current + `\n\n# ADDED ${timestamp}\n${content}\n`;
        fs.writeFileSync(soulFile, updated);
        agent.reloadSoul?.();
        return reply(chatId, mdt`👻 Soul updated. J-Rock remembers who it is.`);
      } catch (e) {
        return reply(chatId, mdt`❌ Failed to update soul: ${e.message}`);
      }
    },

    /** add_skill <name> <content> — add a skill */
    async add_skill(chatId, args) {
      // Split on first space to get name, rest is content
      const firstSpace = args.join(' ').indexOf(' ');
      if (firstSpace === -1) {
        return reply(chatId, mdt`Usage: /add_skill <name> <content>`);
      }

      const name = args.join(' ').slice(0, firstSpace).trim();
      const content = args.join(' ').slice(firstSpace + 1).trim();

      if (!name || !content) {
        return reply(chatId, mdt`Both name and content are required.`);
      }

      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill';
      const skillsDir = path.join(process.cwd(), 'soul', 'skills');
      const f = path.join(skillsDir, `${slug}.md`);

      if (fs.existsSync(f)) {
        return reply(chatId, mdt`⚠️ Skill ${slug}.md already exists.`);
      }

      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(f, `---\nname: ${name}\nenabled: true\n---\n\n${content}\n`);
      agent.reloadSoul?.();

      return reply(chatId, mdt`✅ Skill ${name} saved to soul/skills/${slug}.md`);
    },

    /** add_mcp <name> <command> [args...] — add an MCP server config */
    async add_mcp(chatId, args) {
      const name = (args[0] || '').trim();
      const command = (args[1] || '').trim();
      const mcpArgs = args.slice(2);

      if (!name || !command) {
        return reply(chatId, mdt`Usage: /add_mcp <name> <command> [args...]`);
      }

      const mcpFile = path.join(process.cwd(), 'mcp.json');

      // Read existing config or create new
      let config_data = {};
      if (fs.existsSync(mcpFile)) {
        try {
          config_data = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        } catch (e) {
          config_data = { mcpServers: {} };
        }
      }

      if (!config_data.mcpServers) config_data.mcpServers = {};

      if (config_data.mcpServers[name]) {
        return reply(chatId, mdt`⚠️ MCP server '${name}' already exists. Use /mcp reload after editing.`);
      }

      config_data.mcpServers[name] = {
        command,
        args: mcpArgs.length ? mcpArgs : [],
        enabled: false,
      };

      fs.writeFileSync(mcpFile, JSON.stringify(config_data, null, 2) + '\n');

      return reply(chatId, [
        bold('✅ Added MCP server config'),
        '',
        mdt`Name: ${name}`,
        mdt`Command: ${command}` + (mcpArgs.length ? `\n  Args: ${mcpArgs.join(', ')}` : ''),
        '',
        italic('Run /mcp reload to start it. Set enabled: true in mcp.json to auto-start.'),
      ].join('\n'));
    },

    /** /code_review — review the current codebase for issues */
    async code_review(chatId) {
      await bot.sendTyping(chatId);

      const srcDir = path.join(process.cwd(), 'src');
      if (!fs.existsSync(srcDir)) {
        return reply(chatId, mdt`❌ No src/ directory found.`);
      }

      const files = [];
      const walkDir = (dir, basePath = srcDir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) {
            if (!['node_modules', '.git'].includes(item.name)) walkDir(full, basePath);
          } else if (item.name.endsWith('.js')) {
            files.push(full);
          }
        }
      };
      walkDir(srcDir);

      if (files.length === 0) {
        return reply(chatId, mdt`No .js files found in src/.`);
      }

      const report = [bold('🔍 CODE REVIEW'), ''];
      let issuesFound = 0;

      for (const f of files) {
        const relPath = path.relative(process.cwd(), f);
        const content = fs.readFileSync(f, 'utf8');
        const lines = content.split('\n');

        // Check for common issues
        const checks = [
          {
            name: 'missing catch',
            test: (c) => /try\s*\{/.test(c) && !/catch\s*\(.+\)\s*\{/.test(c),
          },
          {
            name: 'empty promise',
            test: (c) => /\bthrow\b.*Promise/.test(c),
          },
          {
            name: 'TODO/FIXME',
            test: (c) => /\b(TODO|FIXME)\b/.test(c),
          },
        ];

        const fileIssues = [];
        for (const check of checks) {
          const matches = content.split('\n').map((l, i) => ({ line: i + 1, content: l }))
            .filter(l => check.test(l.content));
          for (const m of matches) {
            fileIssues.push(`line ${m.line}: ${m.content.trim().substring(0, 100)}`);
          }
        }

        if (fileIssues.length > 0) {
          issuesFound++;
          report.push(mdt`${relPath}:`);
          for (const issue of fileIssues.slice(0, 3)) {
            report.push(mdt`  • ${issue}`);
          }
          if (fileIssues.length > 3) {
            report.push(mdt`  • ...and ${fileIssues.length - 3} more`);
          }
          report.push('');
        }
      }

      if (issuesFound === 0) {
        report.push(mdt`All files reviewed — no issues found.`);
      } else {
        report.push('', italic(`Total: ${issuesFound} file(s) with issues.`));
      }

      return reply(chatId, report.join('\n'));
    },

    /** /bug_fix <description> — analyze and propose fixes for bugs */
    async bug_fix(chatId, args) {
      await bot.sendTyping(chatId);
      const description = args.join(' ').trim();
      if (!description) {
        return reply(chatId, mdt`Usage: /bug_fix <description of the bug>`);
      }

      // This would normally invoke the agent to generate patches
      // For now, provide a placeholder response
      return reply(chatId, [
        bold('🛠 Bug Fix Proposal'),
        '',
        mdt`Description: ${description}`,
        '',
        italic('In a full implementation, this would:'),
        '  1. Read all source files',
        '  2. Generate edit blocks with the LLM',
        '  3. Show diffs for approval',
        '  4. Apply changes and rebuild',
        '',
        md('Run /code_review first to identify bugs.'),
      ].join('\n'));
    },

    /** /simplify <file> — analyze code for simplification opportunities */
    async simplify(chatId, args) {
      const file = args.join(' ').trim();
      if (!file) {
        return reply(chatId, mdt`Usage: /simplify <file-path>`);
      }

      const filePath = path.join(process.cwd(), file);
      if (!fs.existsSync(filePath)) {
        return reply(chatId, mdt`❌ File not found: ${file}`);
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const linesArr = [bold('🧹 Simplification analysis: ' + md(file)), ''];

      // Simple heuristics for simplification
      const suggestions = [];

      // Check for overly long functions
      const funcMatches = content.match(/function\s+\w+\s*\([^)]*\)\s*\{/g);
      if (funcMatches && content.split('function').length > 3) {
        suggestions.push(`Has ${funcMatches.length} functions — consider extracting helpers`);
      }

      // Check for duplicate code
      const lineCount = content.split('\n').length;
      if (lineCount > 100) {
        suggestions.push(`Is ${lineCount} lines — consider splitting`);
      }

      // Check for magic numbers
      const numbers = content.match(/\b\d{2,}\b/g);
      if (numbers && numbers.length > 5) {
        const unique = [...new Set(numbers)];
        suggestions.push(`Found ${unique.length} numbers ≥ 100 — extract to constants`);
      }

      if (!suggestions.length) {
        linesArr.push(mdt`No simplification opportunities detected.`);
      } else {
        linesArr.push('', bold('Suggestions:'));
        for (const s of suggestions) {
          linesArr.push(mdt`• ${s}`);
        }
      }

      return reply(chatId, linesArr.join('\n'));
    },

    /** /verify <target> — verify system status or specific component */
    async verify(chatId, args) {
      const target = (args[0] || '').toLowerCase();

      if (!target) {
        return reply(chatId, [
          bold('🔍 Verify command'),
          '',
          md('Usage: /verify <target>'),
          '',
          md('Targets:'),
          '  system — comprehensive system check',
          '  database — Neon connection test',
          '  exchange — Bitunix API test',
          '  ai — AI provider connectivity',
          '  telegram — bot functionality',
        ].join('\n'));
      }

      if (target === 'system') {
        return commands.check_system(chatId);
      }

      if (target === 'database') {
        try {
          await db.settings();
          return reply(chatId, bold('✅ Database connection verified.'));
        } catch (e) {
          return reply(chatId, mdt`❌ Database: ${e.message}`);
        }
      }

      if (target === 'exchange') {
        try {
          const b = await availableBalance();
          return reply(chatId, mdt`✅ Exchange: ${Number(b.available).toFixed(2)} USDT available`);
        } catch (e) {
          return reply(chatId, mdt`❌ Exchange: ${e.message}`);
        }
      }

      if (target === 'ai') {
        const st = ai.status();
        const allOk = st.every(p => p.model);
        return reply(chatId, allOk
          ? bold('✅ AI: All providers ready')
          : mdt`⚠️ AI: Some providers not ready — ${st.filter(p => !p.model).map(p => p.provider).join(', ')}`);
      }

      if (target === 'telegram') {
        return reply(chatId, bot.degraded
          ? mdt`❌ Telegram: ${bot.degradedReason || 'degraded'}`
          : bold('✅ Telegram: functional'));
      }

      return reply(chatId, mdt`Unknown verify target: ${target}`);
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
