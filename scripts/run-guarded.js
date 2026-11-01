#!/usr/bin/env node
/**
 * Supervisor for the trader: `npm run start:guarded`.
 *
 *  - restarts src/index.js when it exits (so /restart after an approved repair works)
 *  - if a freshly APPLIED repair makes the new code crash within VERIFY_MS of boot,
 *    it restores the backed-up files itself and starts the old code again.
 *    This file deliberately lives outside what the agent may edit.
 *  - Ctrl-C / SIGTERM stops everything (no restart).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = path.join(ROOT, '.repair-backups');
const MARKER = path.join(BACKUPS, 'PENDING_VERIFY.json');
const VERIFY_MS = 90_000;

let child = null;
let stopping = false;

function rollbackFromMarker(reason) {
  let m;
  try { m = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { return false; }
  for (const rel of m.rels || []) {
    const src = path.join(BACKUPS, String(m.id), rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ROOT, rel));
  }
  fs.writeFileSync(path.join(BACKUPS, 'AUTO_ROLLED_BACK.json'), JSON.stringify({ id: m.id, rels: m.rels, reason }));
  try { fs.unlinkSync(MARKER); } catch { /* ignore */ }
  console.error(`[guard] repair #${m.id} crashed the new code (${reason}) - original files restored`);
  return true;
}

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, stdio: 'inherit' });
  const healthy = setTimeout(() => { try { fs.unlinkSync(MARKER); } catch { /* none pending */ } }, VERIFY_MS);
  child.on('exit', (code, signal) => {
    clearTimeout(healthy);
    if (stopping) process.exit(code ?? 0);
    const quick = Date.now() - startedAt < VERIFY_MS;
    if (code !== 0 && quick && fs.existsSync(MARKER)) rollbackFromMarker(`exit ${code ?? signal} ${Math.round((Date.now() - startedAt) / 1000)}s after boot`);
    const wait = code === 0 ? 1500 : 5000;
    console.error(`[guard] trader exited (${code ?? signal}); restarting in ${wait / 1000}s`);
    setTimeout(start, wait);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; child?.kill(sig); setTimeout(() => process.exit(0), 5000).unref(); });
}
start();
