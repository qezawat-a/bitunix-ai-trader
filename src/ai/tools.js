import bitunix from '../exchange/bitunix.js';
import { createLogger } from '../logger.js';
import { validateSetting } from '../settings-schema.js';
import mcpClient from '../mcp/client.js';
import { scan, analyseSymbol, consensus, buildUniverse, getCandles } from '../scanner/scanner.js';
import { computeDynamicTpSl } from '../trading/risk.js';
import {
  openFromSignal, closePosition, closeAll, upsertPositionTpSl,
  availableBalance, reverse, resetSymbolConfigCache,
} from '../trading/executor.js';
import { livePositions, portfolioSnapshot, manageOpenPositions } from '../trading/manager.js';
import { knownStop, readPositionTpSl } from '../trading/executor.js';
import * as db from '../db/index.js';
import * as I from '../strategies/indicators.js';

const log = createLogger('tools');

const num = { type: 'number' };
const str = { type: 'string' };
const bool = { type: 'boolean' };

/**
 * The agent's tool belt. Each entry:
 *   { name, description, parameters (JSON schema), handler(args) -> any, danger?:true }
 * Everything the agent can *do* to the real account lives here and nowhere else.
 */
export const TOOLS = [
  // ------------------------------------------------------------- market data
  {
    name: 'get_balance',
    description: 'Futures account balance: available, margin in use, frozen, unrealised PnL, position mode.',
    parameters: { type: 'object', properties: {} },
    handler: async () => availableBalance(),
  },
  {
    name: 'get_ticker',
    description: 'Current ticker (mark price, last price, 24h high/low/volume) for one or more symbols.',
    parameters: { type: 'object', properties: { symbols: { type: 'string', description: 'comma separated, e.g. BTCUSDT,ETHUSDT. Omit for all.' } } },
    handler: async ({ symbols }) => {
      const t = await bitunix.getTickers(symbols);
      return symbols ? t : (t || []).slice(0, 50);
    },
  },
  {
    name: 'get_kline',
    description: 'Raw candles for a symbol/timeframe. Valid intervals: 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M.',
    parameters: {
      type: 'object',
      properties: { symbol: str, interval: str, limit: num },
      required: ['symbol', 'interval'],
    },
    handler: async ({ symbol, interval, limit = 100 }) => {
      const c = await getCandles(symbol, interval, Math.max(60, Math.min(400, limit)));
      return c.slice(-Math.min(limit, 60));
    },
  },
  {
    name: 'get_depth',
    description: 'Order book for a symbol. limit: 1/5/15/50/max.',
    parameters: { type: 'object', properties: { symbol: str, limit: str }, required: ['symbol'] },
    handler: ({ symbol, limit = '15' }) => bitunix.getDepth(symbol, limit),
  },
  {
    name: 'get_funding',
    description: 'Current funding rate, next funding time and interval for a symbol.',
    parameters: { type: 'object', properties: { symbol: str }, required: ['symbol'] },
    handler: ({ symbol }) => bitunix.getFundingRate(symbol),
  },
  {
    name: 'get_funding_history',
    description: 'Historical funding rates for a symbol — useful to judge crowded positioning.',
    parameters: { type: 'object', properties: { symbol: str, limit: num }, required: ['symbol'] },
    handler: ({ symbol, limit = 20 }) => bitunix.getFundingRateHistory({ symbol, limit }),
  },
  {
    name: 'get_trading_pairs',
    description: 'Contract specs: precision, min trade volume, leverage limits, status, API support.',
    parameters: { type: 'object', properties: { symbols: str } },
    handler: async ({ symbols }) => {
      const p = await bitunix.getTradingPairs(symbols);
      return symbols ? p : (p || []).slice(0, 60);
    },
  },
  {
    name: 'get_position_tiers',
    description: 'Leverage/margin tiers for a symbol (max leverage per notional bracket).',
    parameters: { type: 'object', properties: { symbol: str }, required: ['symbol'] },
    handler: ({ symbol }) => bitunix.getPositionTiers({ symbol }),
  },

  // ---------------------------------------------------------------- analysis
  {
    name: 'analyse_symbol',
    description: 'Full multi-timeframe analysis of one symbol: regime, ATR, and all six strategies per timeframe, plus the consensus verdict.',
    parameters: { type: 'object', properties: { symbol: str }, required: ['symbol'] },
    handler: async ({ symbol }) => {
      const a = await analyseSymbol(symbol.toUpperCase());
      const c = await consensus(a);
      return {
        symbol: a.symbol, regime: a.regime, price: a.price, atr: a.atr,
        funding: a.funding?.fundingRate,
        timeframes: Object.fromEntries(Object.entries(a.timeframes).map(([tf, v]) => [tf, v.error ? { error: v.error } : {
          regime: v.regime, adx: v.adx, atrPct: Number(v.atrPct?.toFixed(3)),
          strategies: v.results.filter((r) => r.side).map((r) => ({ name: r.name, side: r.side, confidence: Math.round(r.confidence), notes: r.notes })),
        }])),
        consensus: c,
      };
    },
  },
  {
    name: 'scan_market',
    description: 'Run the six-strategy consensus scanner across the trading universe and return the ranked signals (qualified ones first).',
    parameters: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: 'optional comma separated subset' },
        limit: num,
      },
    },
    handler: async ({ symbols, limit = 8 }) => {
      const only = symbols ? symbols.split(',').map((x) => x.trim().toUpperCase()) : null;
      const sigs = await scan({ onlySymbols: only });
      return sigs.slice(0, limit).map((s) => ({
        symbol: s.symbol, side: s.side, confidence: s.confidence, agreement: s.agreement,
        qualified: s.qualified, rejectReason: s.rejectReason, regime: s.regime, htfRegime: s.htfRegime,
        price: s.price, atrPct: Number(s.atrPct?.toFixed(3)), funding: s.funding,
        strategies: s.strategies.map((x) => `${x.name}(${x.confidence}) ${x.timeframes.join('/')}`),
        flags: s.flags, opposite: s.opposite,
      }));
    },
  },
  {
    name: 'preview_risk',
    description: 'Show the dynamic ATR-based TP/SL that WOULD be used for a hypothetical entry, without trading.',
    parameters: {
      type: 'object',
      properties: { symbol: str, side: { type: 'string', enum: ['LONG', 'SHORT'] }, confidence: num, agreement: num },
      required: ['symbol', 'side'],
    },
    handler: async ({ symbol, side, confidence, agreement }) => {
      const a = await analyseSymbol(symbol.toUpperCase());
      const s = db.settings();
      const sig = {
        symbol: a.symbol, side, price: a.price, atr: a.atr,
        confidence: confidence ?? s.min_confidence, agreement: agreement ?? s.min_agreement,
        atrPct: (a.atr / a.price) * 100, regime: a.regime,
      };
      return { ...computeDynamicTpSl(sig), price: a.price, atr: a.atr, regime: a.regime };
    },
  },
  {
    name: 'get_universe',
    description: 'The symbols currently in the scan universe (AUTO = ranked from the full exchange pair list).',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const u = await buildUniverse();
      return { size: u.length, symbols: u };
    },
  },

  // --------------------------------------------------------------- positions
  {
    name: 'get_positions',
    description: 'All open positions with size, entry, leverage, margin, unrealised PnL, ROI %, liq price.',
    parameters: { type: 'object', properties: {} },
    handler: async () => portfolioSnapshot(),
  },
  {
    name: 'get_position_history',
    description: 'Closed position history from the exchange.',
    parameters: { type: 'object', properties: { symbol: str, limit: num } },
    handler: ({ symbol, limit = 10 }) => bitunix.getHistoryPositions({ symbol, limit }),
  },
  {
    name: 'get_order_history',
    description: 'Historical orders from the exchange.',
    parameters: { type: 'object', properties: { symbol: str, limit: num, status: str } },
    handler: ({ symbol, limit = 10, status }) => bitunix.getHistoryOrders({ symbol, limit, status }),
  },
  {
    name: 'get_pending_orders',
    description: 'Currently resting (unfilled) orders.',
    parameters: { type: 'object', properties: { symbol: str } },
    handler: ({ symbol }) => bitunix.getPendingOrders({ symbol }),
  },
  {
    name: 'get_tpsl_orders',
    description: 'Pending TP/SL orders for a position. Returns an explicit '
      + 'protected/unprotected verdict — an empty list is NOT proof a position '
      + 'is naked, so never tell the user their stop is missing on this alone.',
    parameters: { type: 'object', properties: { symbol: str, positionId: str } },
    handler: async ({ symbol, positionId }) => {
      const orders = (await bitunix.getPendingTpSlOrders({ symbol, positionId })) || [];
      // Also read what the ratchet last wrote. The two together tell the agent
      // whether "no orders returned" means unprotected or just unconfirmed —
      // reporting an empty list as "you have no stop" was wrong and alarming.
      const tracked = positionId ? knownStop(positionId) : null;
      // What the exchange actually has on the whole-position order. When this
      // disagrees with lastStopWritten, a write was accepted but never landed.
      const live = await readPositionTpSl({ symbol, positionId });
      const liveSl = live?.slPrice ?? null;
      const drift = liveSl != null && tracked != null
        && Math.abs(liveSl - tracked) > Math.max(Math.abs(tracked) * 1e-4, 1e-9);
      return {
        orders,
        count: orders.length,
        exchangeStop: liveSl,
        exchangeTakeProfit: live?.tpPrice ?? null,
        lastStopWritten: tracked,
        writeDrift: drift
          ? `the exchange stop is ${liveSl} but the bot recorded ${tracked} — a stop write was accepted without taking effect`
          : null,
        verdict: orders.length
          ? 'protected'
          : (tracked != null
            ? 'unconfirmed — the exchange returned no rows, but a stop was written at '
              + `${tracked}; re-check before claiming the position is naked`
            : 'no TP/SL rows returned and none tracked locally'),
      };
    },
  },

  // ------------------------------------------------------------- EXECUTION ⚠
  {
    name: 'open_position',
    description: 'LIVE: open a position from a signal. Dynamic ATR TP/SL is attached automatically. Size is taken from margin_pct of available balance unless margin_usdt is given.',
    danger: true,
    parameters: {
      type: 'object',
      properties: {
        symbol: str,
        side: { type: 'string', enum: ['LONG', 'SHORT'] },
        confidence: num,
        agreement: num,
        margin_usdt: { type: 'number', description: 'override the USDT margin for this trade' },
        reasoning: { type: 'string', description: 'why you are taking this trade' },
      },
      required: ['symbol', 'side'],
    },
    handler: async ({ symbol, side, confidence, agreement, margin_usdt, reasoning }) => {
      const sym = symbol.toUpperCase();
      const a = await analyseSymbol(sym);
      const c = await consensus(a);
      const s = db.settings();
      const sig = {
        symbol: sym, side, price: a.price, atr: a.atr,
        confidence: confidence ?? c?.confidence ?? s.min_confidence,
        agreement: agreement ?? c?.agreement ?? s.min_agreement,
        atrPct: (a.atr / a.price) * 100, regime: a.regime, htfRegime: c?.htfRegime,
        strategies: c?.strategies || [],
      };
      return openFromSignal(sig, { aiVerdict: { reasoning } , marginOverride: margin_usdt });
    },
  },
  {
    name: 'close_position',
    description: 'LIVE: flash-close one position at market by positionId.',
    danger: true,
    parameters: { type: 'object', properties: { positionId: str, reason: str }, required: ['positionId'] },
    handler: ({ positionId, reason }) => closePosition(positionId, reason || 'agent decision'),
  },
  {
    name: 'close_all_positions',
    description: 'LIVE: close every open position (optionally only one symbol).',
    danger: true,
    parameters: { type: 'object', properties: { symbol: str } },
    handler: ({ symbol }) => closeAll(symbol || null),
  },
  {
    name: 'set_position_tpsl',
    description: 'LIVE: place or modify the position-level TP/SL (market close on trigger).',
    danger: true,
    parameters: {
      type: 'object',
      properties: { symbol: str, positionId: str, tpPrice: num, slPrice: num },
      required: ['symbol', 'positionId'],
    },
    handler: (a) => upsertPositionTpSl(a),
  },
  {
    name: 'reverse_position',
    description: 'LIVE: close a position and immediately open the opposite side.',
    danger: true,
    parameters: {
      type: 'object',
      properties: { positionId: str, reasoning: str },
      required: ['positionId'],
    },
    handler: async ({ positionId, reasoning }) => {
      const ps = await livePositions();
      const p = ps.find((x) => String(x.positionId) === String(positionId));
      if (!p) return { ok: false, reason: 'position not found' };
      const a = await analyseSymbol(p.symbol);
      const c = await consensus(a);
      const newSide = p.side === 'LONG' ? 'SHORT' : 'LONG';
      const sig = {
        symbol: p.symbol, side: newSide, price: a.price, atr: a.atr,
        confidence: c?.side === newSide ? c.confidence : db.settings().reversal_confidence,
        agreement: c?.agreement ?? 2, atrPct: (a.atr / a.price) * 100,
        regime: a.regime, strategies: c?.strategies || [],
      };
      return reverse(p, sig, { reasoning });
    },
  },
  {
    name: 'cancel_orders',
    description: 'LIVE: cancel all resting orders (optionally for one symbol).',
    danger: true,
    parameters: { type: 'object', properties: { symbol: str } },
    handler: ({ symbol }) => bitunix.cancelAllOrders(symbol ? { symbol } : {}),
  },
  {
    name: 'run_position_guard',
    description: 'Run one pass of the position guard now: attach missing TP/SL, move stops to breakeven, trail winners, book closed trades.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const r = await manageOpenPositions();
      return { actions: r.actions, positions: r.positions.length };
    },
  },

  // ---------------------------------------------------------------- settings
  {
    name: 'get_settings',
    description: 'All current runtime settings.',
    parameters: { type: 'object', properties: {} },
    handler: async () => db.settings(),
  },
  {
    name: 'update_settings',
    description: 'Change one or more runtime settings (leverage, margin_pct, symbols, timeframes, min_confidence, intervals, reversal, thresholds...). Values are validated: invalid ones come back under "rejected" and are NOT applied.',
    danger: true,
    parameters: {
      type: 'object',
      properties: {
        changes: { type: 'object', description: 'key/value map of settings to change' },
      },
      required: ['changes'],
    },
    handler: async ({ changes }) => {
      // Same validation as /set. The model is confident and occasionally wrong;
      // a bad value here would only surface as a dead loop on the next tick.
      const applied = {};
      const rejected = {};
      for (const [k, v] of Object.entries(changes || {})) {
        if (!(k in db.settings())) {
          rejected[k] = `no such setting. Valid keys: ${Object.keys(db.settings()).join(', ')}`;
          continue;
        }
        try {
          const value = validateSetting(k, v);
          await db.setSetting(k, value, 'agent');
          applied[k] = value;
        } catch (e) {
          rejected[k] = e.message;
        }
      }
      resetSymbolConfigCache();
      const res = { applied, settings: db.settings() };
      if (Object.keys(rejected).length) {
        res.rejected = rejected;
        res.note = 'Rejected values were NOT applied. Tell the user exactly why and do not claim success.';
      }
      return res;
    },
  },
  {
    name: 'set_leverage',
    description: 'LIVE: change leverage for a symbol on the exchange (and in settings if global=true).',
    danger: true,
    parameters: {
      type: 'object',
      properties: { symbol: str, leverage: num, global: bool },
      required: ['leverage'],
    },
    handler: async ({ symbol, leverage, global: g }) => {
      const res = {};
      if (symbol) res.exchange = await bitunix.changeLeverage({ symbol: symbol.toUpperCase(), leverage });
      if (g !== false) { await db.setSetting('leverage', Number(leverage), 'agent'); resetSymbolConfigCache(); }
      return res;
    },
  },
  {
    name: 'set_margin_mode',
    description: 'LIVE: change margin mode (CROSS | ISOLATION) for a symbol. Fails if that symbol has an open position or order.',
    danger: true,
    parameters: {
      type: 'object',
      properties: { symbol: str, marginMode: { type: 'string', enum: ['CROSS', 'ISOLATION'] }, global: bool },
      required: ['marginMode'],
    },
    handler: async ({ symbol, marginMode, global: g }) => {
      const res = {};
      if (symbol) res.exchange = await bitunix.changeMarginMode({ symbol: symbol.toUpperCase(), marginMode });
      if (g !== false) { await db.setSetting('margin_mode', marginMode, 'agent'); resetSymbolConfigCache(); }
      return res;
    },
  },

  // ------------------------------------------------------------------ memory
  {
    name: 'remember',
    description: 'Write something to long-term memory (Neon): a lesson, a user preference, a market note, a rule.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['lesson', 'preference', 'market_note', 'rule', 'error'] },
        subject: { type: 'string', description: 'symbol or topic' },
        content: str,
        importance: { type: 'number', description: '1..10' },
      },
      required: ['kind', 'content'],
    },
    handler: async (a) => ({ id: await db.remember(a) }),
  },
  {
    name: 'recall',
    description: 'Read long-term memory, filtered by subject/kind, or free-text searched.',
    parameters: {
      type: 'object',
      properties: { subject: str, kind: str, search: str, limit: num },
    },
    handler: async ({ subject, kind, search, limit = 10 }) =>
      (search ? db.searchMemories(search, limit) : db.recall({ subject, kind, limit })),
  },
  {
    name: 'get_performance',
    description: 'Trading performance: win/loss, PnL over N days, plus per-strategy live weights.',
    parameters: { type: 'object', properties: { days: num } },
    handler: async ({ days = 7 }) => {
      const stats = await db.tradeStats(days);
      const { rows } = await db.strategyWeights();
      return { window_days: days, ...stats, strategies: rows };
    },
  },
  {
    name: 'get_recent_signals',
    description: 'Recent signals the scanner produced, including the ones that were rejected and why.',
    parameters: { type: 'object', properties: { limit: num } },
    handler: ({ limit = 10 }) => db.recentSignals(limit),
  },
  {
    name: 'get_cooldowns',
    description: 'Symbols currently on cooldown and until when.',
    parameters: { type: 'object', properties: {} },
    handler: () => db.activeCooldowns(),
  },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------- MCP tools
/**
 * Tools discovered from external MCP servers (mcp.json), namespaced
 * `server__tool`. Populated by initMcpTools() at boot; empty until then, so
 * everything works normally when no mcp.json exists.
 */
let externalTools = [];

/** Start the configured MCP servers and adopt their tools. Never throws. */
export async function initMcpTools() {
  try {
    externalTools = await mcpClient.discover();
    if (externalTools.length) {
      log.info(`${externalTools.length} external MCP tool(s) available: ${externalTools.map((t) => t.name).join(', ')}`);
    }
  } catch (e) {
    log.warn(`MCP discovery failed: ${e.message}`);
    externalTools = [];
  }
  return externalTools;
}

/** Re-read mcp.json and restart the servers. */
export async function reloadMcpTools() {
  try { externalTools = await mcpClient.reload(); }
  catch (e) { log.warn(`MCP reload failed: ${e.message}`); }
  return externalTools;
}

export function mcpStatus() { return mcpClient.status(); }

/** Built-ins plus whatever the external servers offer. */
export function allTools() { return [...TOOLS, ...externalTools]; }

export function toolSchemas() {
  return allTools().map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function runTool(name, args = {}) {
  const t = TOOL_MAP[name] || externalTools.find((x) => x.name === name);
  if (!t) return { error: `unknown tool: ${name}` };
  const started = Date.now();
  try {
    const result = await t.handler(args || {});
    log.debug(`${name} ok in ${Date.now() - started}ms`);
    if (t.danger) await db.logEvent('tool_action', { tool: name, args, ok: true });
    return result ?? { ok: true };
  } catch (e) {
    log.warn(`${name} failed: ${e.message}`);
    if (t.danger) await db.logEvent('tool_action', { tool: name, args, ok: false, error: e.message });
    return { error: e.message, code: e.code };
  }
}
