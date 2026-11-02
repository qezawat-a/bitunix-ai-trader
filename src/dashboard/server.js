/**
 * Settings & commands web dashboard for the Bitunix AI Agent Trader.
 *
 * Dependency-free HTTP server built on Node's `http` module, mirroring the
 * pattern in `src/health.js`. It is deliberately never allowed to take the
 * trader down: if the port is taken or the DB is unreachable, the dashboard
 * degrades and the trading loops keep running.
 *
 * Routes:
 *   GET    /                          index.html
 *   GET    /api/settings              all settings
 *   GET    /api/settings/:key         one setting
 *   POST   /api/settings/:key         validate + persist (body: { value })
 *   GET    /api/positions             live positions (enriched)
 *   GET    /api/trades                open trades + stats
 *   GET    /api/signals               recent signals
 *   GET    /api/events                recent agent events
 *   GET    /api/status                health + orchestrator runtime state
 *   POST   /api/command/:name         toggle scan / reports / kill switch
 *   GET    /api/health                liveness
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as db from '../db/index.js';
import { validateSetting } from '../settings-schema.js';
import { SETTING_INFO } from '../telegram/format.js';

const log = createLogger('dashboard');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

let server = null;
let orchestrator = null; // injected from src/index.js

/** Redact values whose key looks like an API credential. Everything else passes through. */
function redact(obj, parentKey = '') {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    const cred = /key|secret|token|password/i.test(parentKey);
    return cred && obj.length > 4 ? '****' + obj.slice(-4) : obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => redact(v, parentKey));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return obj;
}

function json(res, code, body) {
  const payload = JSON.stringify(redact(body));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function routePath(url) {
  return decodeURIComponent(url.split('?')[0]);
}

/** ------------------------------------------------------------------ routes */

async function handleSettings(req, res) {
  const parts = routePath(req.url).split('/').filter(Boolean); // ['api','settings', key?]
  const key = parts[2];

  if (req.method === 'GET') {
    if (key) {
      const s = db.settings();
      if (!(key in s)) return json(res, 404, { error: `unknown setting "${key}"` });
      return json(res, 200, { key, value: s[key], info: SETTING_INFO[key] });
    }
    return json(res, 200, {
      settings: db.settings(),
      defaults: config.defaults,
      info: SETTING_INFO,
    });
  }

  if (req.method === 'POST') {
    if (!key) return json(res, 400, { error: 'missing setting key' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    const { value } = body;
    if (value === undefined) return json(res, 400, { error: 'missing "value"' });

    let coerced;
    try { coerced = validateSetting(key, value); }
    catch (e) { return json(res, 400, { error: e.message }); }

    const result = await db.setSetting(key, coerced, 'dashboard');
    return json(res, result.persisted ? 200 : 202, {
      key, value: coerced, persisted: result.persisted, error: result.error,
      settings: result.settings,
    });
  }

  return json(res, 405, { error: 'method not allowed' });
}

async function handlePositions(req, res) {
  try {
    const positions = await db.openTrades();
    // Enrich with live exchange data where available. livePositions() may throw
    // if the exchange is unreachable — degrade gracefully to just the DB rows.
    let live = [];
    try { live = await import('../trading/manager.js').then((m) => m.livePositions()); }
    catch (e) { log.warn(`dashboard positions: live read failed: ${e.message}`); }
    const liveBySymbol = new Map(live.map((p) => [p.symbol, p]));
    const out = (positions || []).map((t) => {
      const liveRow = liveBySymbol.get(t.symbol);
      return {
        id: t.id,
        position_id: t.position_id,
        symbol: t.symbol,
        side: t.side,
        entry_price: Number(t.entry_price || 0),
        qty: Number(t.qty || 0),
        leverage: Number(t.leverage || 0),
        margin_usdt: Number(t.margin_usdt || 0),
        tp_price: Number(t.tp_price || 0),
        sl_price: Number(t.sl_price || 0),
        unrealized_pnl: liveRow ? Number(liveRow.unrealizedPNL || 0) : null,
        roi: liveRow ? Number(liveRow.roi || 0) : null,
        status: t.status,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
      };
    });
    return json(res, 200, { positions: out });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

async function handleTrades(req, res) {
  try {
    const open = await db.openTrades();
    const stats = await db.tradeStats();
    return json(res, 200, { open, stats });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

async function handleSignals(req, res) {
  try {
    const limit = 50;
    const signals = await db.recentSignals(limit);
    return json(res, 200, { signals });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

async function handleEvents(req, res) {
  try {
    const events = await db.recentEvents(50);
    return json(res, 200, { events });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

async function handleStatus(req, res) {
  const dbInfo = db.dbInfo ? db.dbInfo() : { connected: false };
  const s = db.settings();
  const scan = orchestrator ? orchestrator.scanStatus() : {
    running: false, scanningEnabled: false, reportsEnabled: false, stats: {},
  };
  return json(res, 200, {
    agent: config.agentName,
    db: dbInfo,
    settings: { auto_trade: s.auto_trade, symbols: s.symbols, leverage: s.leverage },
    orchestrator: {
      running: scan.running,
      scanningEnabled: scan.scanningEnabled,
      reportsEnabled: scan.reportsEnabled,
      scans: scan.scans,
      lastScanAt: scan.lastScanAt,
      lastScanError: scan.lastScanError,
      busy: scan.busy,
    },
    stats: orchestrator ? orchestrator.stats : { scans: 0, signals: 0, trades: 0, reversals: 0, errors: 0, startedAt: 0 },
  });
}

async function handleCommand(req, res) {
  const parts = routePath(req.url).split('/').filter(Boolean); // ['api','command', name]
  const name = parts[2];
  if (!name) return json(res, 400, { error: 'missing command name' });

  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}

  try {
    switch (name) {
      case 'scan': {
        const enabled = body.enabled !== false;
        orchestrator.scanningEnabled = enabled;
        return json(res, 200, { command: 'scan', scanningEnabled: enabled });
      }
      case 'reports': {
        const enabled = body.enabled !== false;
        orchestrator.reportsEnabled = enabled;
        return json(res, 200, { command: 'reports', reportsEnabled: enabled });
      }
      case 'kill': {
        // Emergency kill switch: disable auto trading immediately.
        await db.setSetting('auto_trade', false, 'dashboard');
        return json(res, 200, { command: 'kill', auto_trade: false, note: 'auto trading disabled' });
      }
      default:
        return json(res, 404, { error: `unknown command "${name}"` });
    }
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

/** ------------------------------------------------------------------ server */

function handleRequest(req, res) {
  const url = routePath(req.url);

  // Static files
  if (req.method === 'GET' && url === '/') {
    const index = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(index);
  }
  if (req.method === 'GET' && url.startsWith('/api/')) {
    if (url === '/api/settings') return handleSettings(req, res);
    if (url.startsWith('/api/settings/')) return handleSettings(req, res);
    if (url === '/api/positions') return handlePositions(req, res);
    if (url === '/api/trades') return handleTrades(req, res);
    if (url === '/api/signals') return handleSignals(req, res);
    if (url === '/api/events') return handleEvents(req, res);
    if (url === '/api/status') return handleStatus(req, res);
    if (url === '/api/health') return json(res, 200, { ok: true, agent: config.agentName });
    if (url.startsWith('/api/command/')) return handleCommand(req, res);
    return json(res, 404, { error: 'not found' });
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

export function startDashboard(opts = {}) {
  if (!config.dashboard.enabled || !config.dashboard.port) {
    log.info('dashboard disabled (DASHBOARD_ENABLED/DASHBOARD_PORT)');
    return null;
  }
  if (server) return server;

  server = http.createServer(handleRequest);
  const port = config.dashboard.port;

  server.on('error', (e) => {
    log.warn(`dashboard disabled: ${e.message}`);
    server = null;
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`dashboard on http://0.0.0.0:${port} (settings & commands UI)`);
  });
  return server;
}

export function attachOrchestrator(o) {
  orchestrator = o;
}

export async function stopDashboard() {
  try { server?.close(); } catch {}
  server = null;
  orchestrator = null;
}

export function isRunning() {
  return server !== null;
}
