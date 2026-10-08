import { config, assertBootConfig } from './config.js';
import { createLogger } from './logger.js';
import { migrate, seedSettings, loadSettings, settings, pool, logEvent } from './db/index.js';
import bitunix from './exchange/bitunix.js';
import feed from './exchange/ws.js';
import ai from './ai/providers.js';
import { initMcpTools } from './ai/tools.js';
import TelegramBot from './telegram/bot.js';
import { createCommandHandler } from './telegram/commands.js';
import Orchestrator from './orchestrator.js';
import { mdt, md } from './telegram/format.js';
import { STRATEGY_COUNT } from './strategies/index.js';

const log = createLogger('boot');

const BANNER = `
╔══════════════════════════════════════════════════════╗
║   BITUNIX  AI  AGENT  TRADER                         ║
║   agentic · multi-strategy · live · neon · mcp       ║
╚══════════════════════════════════════════════════════╝`;

async function main() {
  console.log(BANNER);
  log.warn('LIVE TRADING — there is no dry-run mode. Real orders will be placed.');

  assertBootConfig();

  // ---- database -------------------------------------------------------
  await migrate();
  await seedSettings();
  await loadSettings();
  log.info('neon connected, settings loaded');

  // ---- exchange sanity check -----------------------------------------
  const pairs = await bitunix.getTradingPairs();
  log.info(`bitunix reachable — ${pairs.length} futures pairs`);
  const acc = await bitunix.getAccount();
  const a = Array.isArray(acc) ? acc[0] : acc;
  log.info(`account ok — available ${a?.available} ${a?.marginCoin}, position mode ${a?.positionMode}`);

  // ---- AI -------------------------------------------------------------
  if (!ai.available) throw new Error('No AI provider key configured');
  await ai.refreshModels();

  // external MCP servers from mcp.json — optional, never fatal
  const mcpTools = await initMcpTools();
  if (mcpTools.length) log.info(`MCP: ${mcpTools.length} external tool(s) loaded`);
  log.info('models: ' + ai.status().map((p) => `${p.provider}=${p.model}`).join(' '));

  // ---- websocket feed --------------------------------------------------
  feed.start();
  feed.subscribePrivate();

  // ---- telegram --------------------------------------------------------
  // start() degrades instead of throwing: a bad bot token must not take the
  // trader down, because the trader is what manages real positions.
  const bot = new TelegramBot();
  const me = await bot.start();

  const chatIds = config.telegram.allowed.length
    ? config.telegram.allowed
    : [];
  if (!chatIds.length) {
    log.warn('TELEGRAM_ALLOWED_CHAT_IDS is empty — the agent will answer anyone and cannot push reports. Set it!');
  }

  const orchestrator = new Orchestrator({ bot, chatIds });
  bot.onMessage(createCommandHandler({ bot, orchestrator }));

  const s = settings();
  // No bot, no chat ids, or a degraded bot — there is nobody to tell. Say it in
  // the log instead of crashing on me.username.
  if (bot.degraded) {
    log.error('running headless — Telegram is down, so no reports and no /commands. Fix TELEGRAM_BOT_TOKEN to restore control.');
  } else if (!chatIds.length) {
    log.warn('no allowed chat ids — startup notice not sent');
  } else {
    for (const id of chatIds) {
      await bot.sendMessage(id, [
        mdt`🟢 ${config.agentName} is live as @${me.username}.`,
        mdt`${pairs.length} pairs · ${s.leverage}x ${s.margin_mode} ${s.position_mode} · order unit ${s.order_unit}`,
        mdt`gates ${s.min_agreement}/${STRATEGY_COUNT} @ ${s.min_confidence}% · cooldown ${s.cooldown_min}m · reversal ${s.reversal_enabled ? s.reversal_confidence + '%' : 'off'}`,
        mdt`auto trade ${s.auto_trade ? 'ON' : 'OFF'} · thinking ${s.thinking_level}`,
        mdt`models: ${ai.status().map((p) => p.model).join(', ')}`,
        '',
        md('/help for commands — or just talk to me.'),
      ].join('\n'));
    }
  }

  orchestrator.start();
  await logEvent('agent_started', { pairs: pairs.length, settings: s });
  log.info('🚀 agent running');

  // ---- shutdown --------------------------------------------------------
  const shutdown = async (sig) => {
    log.warn(`${sig} — shutting down (open positions are NOT closed)`);
    orchestrator.stop();
    bot.stop();
    feed.stop();
    try { await logEvent('agent_stopped', { signal: sig }); } catch {}
    try { await pool.end(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e?.stack || e));
  process.on('uncaughtException', (e) => log.error('uncaughtException:', e?.stack || e));
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
