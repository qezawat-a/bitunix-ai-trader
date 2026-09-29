import { config, assertBootConfig } from './config.js';
import { createLogger } from './logger.js';
import { connect as connectDb, migrate, seedSettings, loadSettings, settings, close as closeDb, logEvent } from './db/index.js';
import { startHealthServer, stopHealthServer, setHealth } from './health.js';
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

  // Bind the port first: the platform's health probe starts the moment the
  // container is up, and a slow database must not read as a dead service.
  startHealthServer();

  assertBootConfig();

  // ---- database -------------------------------------------------------
  setHealth('connecting to database');
  await connectDb();
  setHealth('migrating');
  await migrate();
  await seedSettings();
  await loadSettings();
  log.info('database connected, settings loaded');

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

  orchestrator.start();
  await logEvent('agent_started', { pairs: pairs.length, settings: s });
  setHealth('running');
  log.info('🚀 agent running');

  // ---- shutdown --------------------------------------------------------
  const shutdown = async (sig) => {
    log.warn(`${sig} — shutting down (open positions are NOT closed)`);
    setHealth('shutting down');
    orchestrator.stop();
    bot.stop();
    feed.stop();
    stopHealthServer();
    try { await logEvent('agent_stopped', { signal: sig }); } catch {}
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e?.stack || e));
  process.on('uncaughtException', (e) => log.error('uncaughtException:', e?.stack || e));
}

main().catch((e) => {
  // A crashed deploy shows only this. Make it the whole story: what broke,
  // and what to change — not a stack trace through the pg driver.
  log.error(e.message);
  for (const hint of e.hints || []) log.error(`   → ${hint}`);
  if (!e.hints?.length && e.stack) log.error(e.stack);
  if (e.cause?.stack && process.env.LOG_LEVEL === 'debug') log.error(e.cause.stack);
  setHealth('crashed', e.message);
  process.exit(1);
});
