#!/usr/bin/env node
/**
 * Smoke-test the MCP server the way a client would: spawn it over stdio,
 * speak JSON-RPC 2.0, and report what it exposes.
 *   npm run mcp:test
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'src', 'mcp', 'server.js');

const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 30_000);
});

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };

try {
  console.log('\nMCP server smoke test\n');

  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-test', version: '1.0.0' },
  });
  if (init.error) throw new Error(JSON.stringify(init.error));
  ok(`initialize — ${init.result.serverInfo.name} v${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);

  const tools = (await call('tools/list')).result.tools;
  const live = tools.filter((t) => /LIVE/.test(t.description || ''));
  ok(`tools/list — ${tools.length} tools (${live.length} marked LIVE)`);

  const res = (await call('resources/list')).result.resources;
  ok(`resources/list — ${res.map((r) => r.uri).join(', ')}`);

  const prompts = (await call('prompts/list')).result.prompts;
  ok(`prompts/list — ${prompts.map((p) => p.name).join(', ')}`);

  const read = await call('resources/read', { uri: 'agent://skill' });
  const text = read.result?.contents?.[0]?.text || '';
  text.length > 100 ? ok(`resources/read agent://skill — ${text.length} chars`) : bad('agent://skill looks empty');

  const t = await call('tools/call', { name: 'get_ticker', arguments: { symbol: 'BTCUSDT' } });
  t.error ? bad(`get_ticker — ${t.error.message}`) : ok('tools/call get_ticker — live data returned');

  const e = await call('tools/call', { name: 'no_such_tool', arguments: {} });
  e.error ? ok(`unknown tool rejected (${e.error.code})`) : bad('unknown tool was not rejected');

  console.log('\n\x1b[32mServer is speaking MCP correctly.\x1b[0m');
  console.log('Next:  node scripts/mcp-config.js\n');
} catch (err) {
  bad(err.message);
} finally {
  child.kill();
}
