#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) server — stdio transport, JSON-RPC 2.0.
 *
 * Exposes the whole trading tool belt to any MCP client (Claude Desktop,
 * Cursor, Cline, another agent...). Zero SDK dependency: the protocol is
 * implemented directly so the project stays dependency-light.
 *
 *   node src/mcp/server.js
 *
 * Claude Desktop config example:
 * {
 *   "mcpServers": {
 *     "bitunix-trader": {
 *       "command": "node",
 *       "args": ["/abs/path/bitunix-ai-trader/src/mcp/server.js"],
 *       "env": { "DATABASE_URL": "...", "BITUNIX_API_KEY": "...", "BITUNIX_API_SECRET": "..." }
 *     }
 *   }
 * }
 */
import readline from 'node:readline';
import { TOOLS, TOOL_MAP, runTool } from '../ai/tools.js';
import { loadSettings, seedSettings, migrate, recall } from '../db/index.js';
import { loadSoul } from '../ai/soul.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'bitunix-ai-trader', version: '1.0.0' };

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function result(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });
}

const handlers = {
  initialize: () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: {} },
    serverInfo: SERVER_INFO,
  }),

  'tools/list': () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: (t.danger ? '[LIVE ACCOUNT ACTION] ' : '') + t.description,
      inputSchema: t.parameters,
    })),
  }),

  'tools/call': async (params) => {
    const name = params?.name;

    // A tool that does not exist is a protocol-level mistake by the client:
    // it must surface as a JSON-RPC error (-32602), not as a successful call
    // whose payload happens to contain an error. Otherwise the client cannot
    // tell "you typed the name wrong" from "the trade was rejected".
    if (!name || !TOOL_MAP[name]) {
      const err = new Error(`Unknown tool: ${name}`);
      err.code = -32602;
      err.data = { available: Object.keys(TOOL_MAP) };
      throw err;
    }

    // A real tool that fails is a normal result with isError — the model is
    // meant to read the message and react.
    const out = await runTool(name, params.arguments || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2).slice(0, 60000) }],
      isError: Boolean(out?.error),
    };
  },

  'resources/list': () => ({
    resources: [
      { uri: 'agent://soul', name: 'Agent soul', description: 'Identity and trading philosophy', mimeType: 'text/markdown' },
      { uri: 'agent://skill', name: 'Agent skill', description: 'Strategy and risk expertise', mimeType: 'text/markdown' },
      { uri: 'agent://style', name: 'Agent style', description: 'Communication style', mimeType: 'text/markdown' },
      { uri: 'agent://memory', name: 'Long-term memory', description: 'Lessons and preferences stored in Neon', mimeType: 'application/json' },
    ],
  }),

  'resources/read': async (params) => {
    const soul = loadSoul();
    const map = { 'agent://soul': soul.soul, 'agent://skill': soul.skill, 'agent://style': soul.style };
    if (params.uri === 'agent://memory') {
      const mem = await recall({ limit: 50 });
      return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(mem, null, 2) }] };
    }
    const text = map[params.uri];
    if (text == null) {
      const err = new Error(`Unknown resource: ${params.uri}`);
      err.code = -32602;
      throw err;
    }
    return { contents: [{ uri: params.uri, mimeType: 'text/markdown', text }] };
  },

  'prompts/list': () => ({
    prompts: [
      { name: 'analyse', description: 'Full multi-timeframe analysis of a symbol', arguments: [{ name: 'symbol', required: true }] },
      { name: 'risk_review', description: 'Review current exposure and protection on all open positions' },
    ],
  }),

  'prompts/get': (params) => {
    const sym = params.arguments?.symbol || 'BTCUSDT';
    const texts = {
      analyse: `Run analyse_symbol on ${sym}, then preview_risk for the side the consensus favours. Give me the regime, which of the six strategies fired, the dynamic TP/SL with its ATR multiple and R, and your honest verdict on whether it is worth taking.`,
      risk_review: 'Call get_positions and get_tpsl_orders. For every open position tell me: is it protected, where is the stop relative to entry, what is the ROI, and should the stop move. Then call run_position_guard if anything needs fixing.',
    };
    return {
      messages: [{ role: 'user', content: { type: 'text', text: texts[params.name] || texts.analyse } }],
    };
  },

  'notifications/initialized': () => null,
  ping: () => ({}),
};

async function main() {
  try { await migrate(); await seedSettings(); } catch {}
  try { await loadSettings(); } catch {}

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const h = handlers[msg.method];
    if (!h) {
      if (msg.id !== undefined) error(msg.id, -32601, `Method not found: ${msg.method}`);
      continue;
    }
    try {
      const r = await h(msg.params || {});
      if (msg.id !== undefined && r !== null) result(msg.id, r);
    } catch (e) {
      if (msg.id !== undefined) error(msg.id, e.code ?? -32603, e.message, e.data);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
