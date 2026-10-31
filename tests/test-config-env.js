/**
 * Hermetic test for the .env authority guard in src/config.js.
 *
 * The guard exists because this app can be started from a shell that exports
 * unrelated variables (measured 2026-10-07: a local dev harness leaked
 * DATABASE_URL, a foreign TELEGRAM_BOT_TOKEN and a local ANTHROPIC_BASE_URL,
 * which silently rerouted the agent). dotenv itself never overrides existing
 * process env, so config.js enforces .env authority for the critical keys and
 * warns on every override.
 *
 * Each scenario spawns a real `node` child process in a temp dir with a
 * crafted .env and a polluted process env — no fake values from the real .env
 * ever appear here.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(repoRoot, 'src', 'config.js');

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

// The child resolves values the same way src/index.js does, then prints them.
const CHILD = `
import { config } from ${JSON.stringify(CONFIG)};
console.log(JSON.stringify({
  db: config.db.url,
  token: config.telegram.token,
  ids: config.telegram.allowed.join(','),
  aurl: config.ai.anthropic.url,
  provider: config.ai.provider,
}));
`;

const ENV_FILE = [
  'DATABASE_URL=postgresql://file-wins@neon-file.test/db?sslmode=require',
  'TELEGRAM_BOT_TOKEN=file-wins-token',
  'TELEGRAM_ALLOWED_CHAT_IDS=42',
  'ANTHROPIC_BASE_URL=https://file-wins.example.com/v1',
  'AI_PROVIDER=ANTHROPIC',
  '',
].join('\n');

const POLLUTED = {
  DATABASE_URL: 'sqlite:///data/other-app.db',
  TELEGRAM_BOT_TOKEN: 'leaked-other-bot:AAxx',
  TELEGRAM_ALLOWED_CHAT_IDS: '999',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:8082',
  AI_PROVIDER: 'OPENAI',
};

function runChild({ cwd, env }) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd,
    env, // caller supplies the complete env — a partial one would break PATH etc.
    encoding: 'utf8',
  });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

function test() {
  console.log('=== config .env authority guard ===\n');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trader-cfg-'));
  try {
    // 1. polluted env + .env present  -> .env wins, with a loud warning
    writeFileSync(path.join(dir, '.env'), ENV_FILE);
    console.log('polluted process env + .env present');
    const { out, err, status } = runChild({ cwd: dir, env: { ...process.env, ...POLLUTED } });
    assert(status === 0, `child exits 0 (got ${status})`);
    const got = JSON.parse(out);
    assert(got.db === 'postgresql://file-wins@neon-file.test/db?sslmode=require', 'DATABASE_URL comes from .env, not the leaked sqlite URL');
    assert(got.token === 'file-wins-token', 'TELEGRAM_BOT_TOKEN comes from .env, not the foreign bot');
    assert(got.ids === '42', 'TELEGRAM_ALLOWED_CHAT_IDS comes from .env, not the leaked chat id');
    assert(got.aurl === 'https://file-wins.example.com/v1', 'ANTHROPIC_BASE_URL comes from .env, not the local proxy');
    assert(got.provider === 'ANTHROPIC', 'AI_PROVIDER comes from .env');
    assert(err.includes('[config] .env takes authority over leaked process env for:'), 'override is logged, not silent');
    for (const k of Object.keys(POLLUTED)) assert(err.includes(k), `warning names the shadowed key ${k}`);
    assert(!err.includes('file-wins'), 'no secret values leak into the warning');

    // 2. clean env + .env present -> dotenv loads it, no warning
    console.log('\nclean process env + .env present');
    const cleanEnv = { ...process.env };
    for (const k of Object.keys(POLLUTED)) delete cleanEnv[k];
    const c2 = runChild({ cwd: dir, env: cleanEnv });
    assert(c2.status === 0, `child exits 0 (got ${c2.status})`);
    const got2 = JSON.parse(c2.out);
    assert(got2.db.includes('file-wins'), 'values still resolve from .env');
    assert(!c2.err.includes('[config]'), 'no false-positive warning when nothing was leaked');

    // 3. polluted env, NO .env file -> ordinary dotenv semantics (env wins),
    //    no crash: this is the Railway deploy path, where the platform
    //    provides env vars and there is no .env on disk.
    console.log('\npolluted process env, no .env file (deploy path)');
    rmSync(path.join(dir, '.env'));
    const c3 = runChild({ cwd: dir, env: { ...process.env, ...POLLUTED } });
    assert(c3.status === 0, `child exits 0 (got ${c3.status})`);
    const got3 = JSON.parse(c3.out);
    assert(got3.db === 'sqlite:///data/other-app.db', 'process env is respected when no .env exists');
    assert(got3.token === 'leaked-other-bot:AAxx', 'process env is respected when no .env exists');
    assert(!c3.err.includes('[config]'), 'guard is a no-op without a .env file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\npassed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

test();
