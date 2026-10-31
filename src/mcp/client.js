/**
 * MCP CLIENT — lets THIS agent use external MCP servers.
 *
 * The agent already *is* an MCP server (src/mcp/server.js). This is the other
 * direction: it spawns servers like
 *
 *     npx -y @modelcontextprotocol/server-brave-search
 *
 * discovers their tools, and merges them into the agent's own tool belt so the
 * LLM can call them exactly like a built-in one.
 *
 * Configured in mcp.json at the project root (see mcp.example.json).
 *
 * Design notes
 * - Tools are namespaced `server__tool` so two servers can both expose "search".
 * - A server that fails to start is logged and skipped. One broken entry must
 *   never stop the trader from booting.
 * - Servers are started lazily on first use and kept alive; a crashed server is
 *   restarted on the next call.
 * - Everything is stdio JSON-RPC 2.0, no SDK dependency, same as the server.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-client');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, 'mcp.json');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'bitunix-ai-trader', version: '1.0.0' };

const START_TIMEOUT_MS = 60_000;   // npx may need to download the package
const CALL_TIMEOUT_MS = 120_000;

/** One external MCP server: a child process plus a JSON-RPC channel. */
class McpServerConnection {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.child = null;
    this.tools = [];
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.starting = null;
    this.failed = null;      // last start error, so we do not retry in a hot loop
    this.failedAt = 0;
  }

  get enabled() { return this.spec.enabled !== false && !this.spec.disabled; }

  async start() {
    if (this.child && !this.child.killed) return this;
    if (this.starting) return this.starting;

    // back off for a minute after a failed start
    if (this.failed && Date.now() - this.failedAt < 60_000) throw this.failed;

    this.starting = (async () => {
      const { command, args = [], env = {}, cwd } = this.spec;
      log.info(`starting "${this.name}": ${command} ${args.join(' ')}`);

      const child = spawn(command, args, {
        cwd: cwd || ROOT,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.on('error', (e) => log.warn(`[${this.name}] spawn error: ${e.message}`));
      child.stderr.on('data', (d) => {
        const line = String(d).trim();
        if (line) log.debug(`[${this.name}] ${line.slice(0, 300)}`);
      });
      child.stdout.on('data', (d) => this._onData(d));
      child.on('exit', (code) => {
        log.warn(`[${this.name}] exited (code ${code})`);
        for (const [, p] of this.pending) p.reject(new Error(`${this.name} exited`));
        this.pending.clear();
        this.child = null;
      });

      this.child = child;

      const init = await this._rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: CLIENT_INFO,
      }, START_TIMEOUT_MS);

      // the spec wants this notification after initialize
      this._notify('notifications/initialized');

      const info = init?.serverInfo;
      const listed = await this._rpc('tools/list', {}, START_TIMEOUT_MS).catch(() => ({ tools: [] }));
      this.tools = listed?.tools || [];

      log.info(`"${this.name}" ready — ${info?.name || '?'} v${info?.version || '?'}, ${this.tools.length} tool(s)`);
      this.failed = null;
      return this;
    })();

    try {
      return await this.starting;
    } catch (e) {
      this.failed = e;
      this.failedAt = Date.now();
      try { this.child?.kill(); } catch {}
      this.child = null;
      throw e;
    } finally {
      this.starting = null;
    }
  }

  _onData(chunk) {
    this.buf += chunk.toString();
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }   // some servers log plain text
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  _notify(method, params = {}) {
    try { this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
    catch {}
  }

  _rpc(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) return reject(new Error(`${this.name} is not running`));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}.${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async callTool(toolName, args) {
    await this.start();
    const out = await this._rpc('tools/call', { name: toolName, arguments: args || {} });

    // MCP returns content blocks; flatten to something an LLM can read.
    const text = (out?.content || [])
      .map((c) => (c.type === 'text' ? c.text
        : c.type === 'resource' ? `[resource ${c.resource?.uri || ''}]\n${c.resource?.text || ''}`
        : `[${c.type}]`))
      .join('\n')
      .trim();

    if (out?.isError) return { error: text || 'tool reported an error' };
    return text ? { result: text } : (out ?? { ok: true });
  }

  stop() {
    try { this.child?.kill(); } catch {}
    this.child = null;
  }
}

/** Registry of every configured external server. */
class McpClient {
  constructor() {
    this.servers = new Map();
    this.loaded = false;
  }

  /** Read mcp.json. Safe to call repeatedly. */
  loadConfig() {
    this.servers.clear();
    this.loaded = true;

    let raw;
    try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); }
    catch { return this; }   // no mcp.json is the normal case

    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      log.warn(`mcp.json is not valid JSON (${e.message}) — ignoring it`);
      return this;
    }

    const entries = cfg.mcpServers || cfg.servers || {};
    for (const [name, spec] of Object.entries(entries)) {
      if (!spec?.command) { log.warn(`mcp.json: "${name}" has no command — skipped`); continue; }
      const conn = new McpServerConnection(name, spec);
      if (!conn.enabled) { log.info(`mcp.json: "${name}" is disabled`); continue; }
      this.servers.set(name, conn);
    }
    if (this.servers.size) log.info(`mcp.json: ${this.servers.size} external server(s) configured`);
    return this;
  }

  /**
   * Start every server and collect their tools.
   * Failures are logged and skipped — never thrown.
   * @returns {Promise<Array>} tool descriptors in this project's own shape
   */
  async discover() {
    if (!this.loaded) this.loadConfig();
    if (!this.servers.size) return [];

    const results = await Promise.allSettled(
      [...this.servers.values()].map((s) => s.start()),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const name = [...this.servers.keys()][i];
        log.warn(`"${name}" failed to start: ${r.reason?.message} — its tools are unavailable`);
      }
    });

    return this.toolDescriptors();
  }

  /** External tools, namespaced and shaped like the built-in ones. */
  toolDescriptors() {
    const out = [];
    for (const [serverName, conn] of this.servers) {
      for (const t of conn.tools) {
        out.push({
          name: `${serverName}__${t.name}`,
          description: `[MCP:${serverName}] ${t.description || t.name}`,
          parameters: normaliseSchema(t.inputSchema),
          external: true,
          server: serverName,
          remoteName: t.name,
          handler: (args) => conn.callTool(t.name, args),
        });
      }
    }
    return out;
  }

  isExternal(name) { return name.includes('__') && this.servers.has(name.split('__')[0]); }

  async call(name, args) {
    const [serverName, ...rest] = name.split('__');
    const conn = this.servers.get(serverName);
    if (!conn) return { error: `no MCP server called "${serverName}"` };
    try {
      return await conn.callTool(rest.join('__'), args);
    } catch (e) {
      return { error: `${name}: ${e.message}` };
    }
  }

  status() {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      command: `${s.spec.command} ${(s.spec.args || []).join(' ')}`.trim(),
      running: Boolean(s.child && !s.child.killed),
      tools: s.tools.length,
      toolNames: s.tools.map((t) => t.name),
      error: s.failed?.message || null,
    }));
  }

  /** Restart everything — used by /mcp reload after editing mcp.json. */
  async reload() {
    this.stopAll();
    this.loadConfig();
    return this.discover();
  }

  stopAll() { for (const s of this.servers.values()) s.stop(); }
}

/**
 * MCP servers vary in how strictly they describe their input. The LLM
 * providers want a plain JSON Schema object, so fill in the gaps.
 */
function normaliseSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = { ...schema };
  if (!s.type) s.type = 'object';
  if (s.type === 'object' && !s.properties) s.properties = {};
  delete s.$schema;
  delete s.additionalProperties;
  return s;
}

export const mcpClient = new McpClient();
export default mcpClient;
