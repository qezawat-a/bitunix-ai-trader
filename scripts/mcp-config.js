#!/usr/bin/env node
/**
 * Print a ready-to-paste MCP client config for THIS checkout.
 *
 *   node scripts/mcp-config.js            # generic / Claude Desktop
 *   node scripts/mcp-config.js --path     # just show where the config file lives
 *
 * Absolute paths and your real env values are filled in, so it can be pasted
 * straight into the client without editing.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const server = path.join(root, 'src', 'mcp', 'server.js');

const KEYS = [
  'DATABASE_URL',
  'BITUNIX_API_KEY', 'BITUNIX_API_SECRET',
  'AI_PROVIDER',
  'OPENAI_COMPATIBLE_KEY', 'OPENAI_COMPATIBLE_URL', 'OPENAI_COMPATIBLE_MODEL',
  'GEMINI_GOOGLE_KEY', 'GEMINI_GOOGLE_URL', 'GEMINI_GOOGLE_MODEL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
];

const env = {};
for (const k of KEYS) if (process.env[k]) env[k] = process.env[k];

const config = {
  mcpServers: {
    'bitunix-trader': { command: process.execPath, args: [server], env },
  },
};

const CONFIG_PATHS = {
  'Claude Desktop (macOS)': '~/Library/Application Support/Claude/claude_desktop_config.json',
  'Claude Desktop (Windows)': '%APPDATA%\\Claude\\claude_desktop_config.json',
  'Claude Desktop (Linux)': '~/.config/Claude/claude_desktop_config.json',
  'Cursor': '~/.cursor/mcp.json  (or .cursor/mcp.json in a project)',
  'Claude Code': 'run:  claude mcp add bitunix-trader -- node ' + server,
};

if (process.argv.includes('--path')) {
  for (const [k, v] of Object.entries(CONFIG_PATHS)) console.log(`${k.padEnd(26)} ${v}`);
  process.exit(0);
}

const missing = KEYS.filter((k) => ['DATABASE_URL', 'BITUNIX_API_KEY', 'BITUNIX_API_SECRET'].includes(k) && !process.env[k]);

console.log('\n── paste this into your MCP client config ──\n');
console.log(JSON.stringify(config, null, 2));
console.log('\n── where that file lives ──\n');
for (const [k, v] of Object.entries(CONFIG_PATHS)) console.log(`  ${k.padEnd(26)} ${v}`);

if (missing.length) {
  console.log(`\n⚠️  not set in .env, so omitted: ${missing.join(', ')}`);
  console.log('   Without them the live tools will fail with Bitunix 100006.');
}
console.log('\nVerify the server itself first:  npm run mcp:test\n');
