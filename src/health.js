/**
 * A health endpoint, for the benefit of the host rather than the trader.
 *
 * The agent is a worker: it polls Telegram and the exchange and never needs
 * to listen on a socket. Hosting platforms do not know that. Railway, Render
 * and friends watch for a process that binds `$PORT`, and a service that
 * never does is reported as unhealthy and restarted — a trading loop killed
 * every couple of minutes for the crime of not being a web server.
 *
 * So: if the platform gave us a PORT, answer it. Off by default locally.
 */
import http from 'node:http';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { dbInfo } from './db/index.js';

const log = createLogger('health');
const startedAt = Date.now();

let server = null;
let state = { phase: 'booting', detail: null };

/** Boot progress, surfaced at /health so a failing deploy is readable. */
export function setHealth(phase, detail = null) {
  state = { phase, detail };
}

function snapshot() {
  const db = dbInfo();
  return {
    ok: state.phase === 'running' && db.connected,
    agent: config.agentName,
    phase: state.phase,
    detail: state.detail,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    db: { connected: db.connected, host: db.host ?? null, database: db.database ?? null, ssl: db.ssl, source: db.source },
  };
}

export function startHealthServer() {
  if (!config.http.enabled || server) return null;
  const port = config.http.port || 8080;

  server = http.createServer((req, res) => {
    const body = snapshot();
    // Unhealthy means "this deploy is dead", not "the database blipped": the
    // data layer degrades to neutral defaults on purpose, and having the host
    // restart a live trading loop over a transient Neon hiccup would be worse
    // than the hiccup. Booting counts as healthy so a slow start is not
    // mistaken for a failed one.
    const code = body.phase === 'crashed' ? 503 : 200;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body, null, 2));
  });

  // A health server that cannot bind must never take the trader down with it.
  server.on('error', (e) => {
    log.warn(`health server disabled: ${e.message}`);
    server = null;
  });

  // 0.0.0.0, not localhost: the platform's probe comes from outside the container.
  server.listen(port, '0.0.0.0', () => log.info(`health endpoint on :${port}/health`));
  return server;
}

export function stopHealthServer() {
  try { server?.close(); } catch {}
  server = null;
}
