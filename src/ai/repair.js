import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { q } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('repair');
const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKUPS = path.join(ROOT, '.repair-backups');
const MARKER = path.join(BACKUPS, 'PENDING_VERIFY.json');

/**
 * Self-repair with a human in the loop.
 *
 *   propose  - the agent (LLM tool) submits exact old_str -> new_str edits. This
 *              only VALIDATES and STORES them. No file is touched.
 *   apply    - runs only from the Telegram /approve command (allow-listed chat),
 *              never from a tool the model can call. Back up, write, syntax-check,
 *              run the test suite, roll back automatically if anything got worse.
 *   rollback - /rollback restores the backed-up originals.
 *
 * The files that make this safe are off-limits to the agent's own edits.
 */

const DENY = [
  /^\.env/i, /^\.git(\/|$)/, /^node_modules(\/|$)/, /^\.repair-backups(\/|$)/,
  /^src\/ai\/repair\.js$/, /^scripts\/run-guarded\.js$/,
  /\.(pem|key)$/i, /id_rsa/i,
];

/** Resolve a repo-relative path or throw. Returns { rel, abs }. */
export function safePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path is required');
  if (path.isAbsolute(p)) throw new Error('path must be relative to the repo root');
  const abs = path.resolve(ROOT, p);
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) throw new Error(`path escapes the repo: ${p}`);
  if (DENY.some((re) => re.test(rel))) throw new Error(`${rel} is protected and cannot be read or edited by the agent`);
  return { rel, abs };
}

export function readSource(p, start = 1, end = null) {
  const { rel, abs } = safePath(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`${rel}: no such file`);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const a = Math.max(1, Number(start) || 1);
  const b = Math.min(lines.length, end ? Number(end) : a + 199, a + 249);
  return {
    path: rel, totalLines: lines.length, from: a, to: b,
    text: lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n'),
  };
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0; let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  return n;
}

/** Apply edits in memory against current disk content. Throws on any mismatch. */
export function simulate(edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('edits must be a non-empty array');
  if (edits.length > 12) throw new Error('too many edits in one proposal (max 12)');
  const files = new Map();   // rel -> { abs, before, after }
  for (const e of edits) {
    const { rel, abs } = safePath(e.path);
    if (typeof e.old_str !== 'string' || !e.old_str.length) throw new Error(`${rel}: old_str is required`);
    if (typeof e.new_str !== 'string') throw new Error(`${rel}: new_str is required`);
    if (!files.has(rel)) {
      if (!fs.existsSync(abs)) throw new Error(`${rel}: file does not exist (the agent may only edit existing files)`);
      const before = fs.readFileSync(abs, 'utf8');
      files.set(rel, { abs, before, after: before });
    }
    const f = files.get(rel);
    const n = countOccurrences(f.after, e.old_str);
    if (n !== 1) throw new Error(`${rel}: old_str must match exactly once, matched ${n} time(s)`);
    f.after = f.after.replace(e.old_str, () => e.new_str);
  }
  return [...files].map(([rel, f]) => ({ rel, ...f }));
}

async function syntaxCheck(rel, content) {
  if (!/\.(m?js)$/.test(rel)) return;
  const tmp = path.join(os.tmpdir(), `repair-check-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, content);
  try { await run(process.execPath, ['--check', tmp]); }
  catch (e) { throw new Error(`${rel}: syntax error after edit - ${String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ')}`); }
  finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

export function renderDiff(edits) {
  return edits.map((e) => {
    const { rel } = safePath(e.path);
    const cur = fs.readFileSync(safePath(e.path).abs, 'utf8');
    const at = cur.indexOf(e.old_str);
    const line = at < 0 ? '?' : cur.slice(0, at).split('\n').length;
    const minus = e.old_str.split('\n').map((l) => `- ${l}`).join('\n');
    const plus = e.new_str.split('\n').map((l) => `+ ${l}`).join('\n');
    return `--- ${rel} (line ${line})\n${minus}\n${plus}`;
  }).join('\n\n');
}

export async function propose({ title, diagnosis, edits, by = 'agent' }) {
  if (!title || !diagnosis) throw new Error('title and diagnosis are required');
  const sim = simulate(edits);
  for (const f of sim) await syntaxCheck(f.rel, f.after);
  const diff = renderDiff(edits);
  const { rows } = await q(
    `INSERT INTO repair_proposals (title, diagnosis, edits, diff, proposed_by) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id`,
    [String(title).slice(0, 200), String(diagnosis).slice(0, 4000), JSON.stringify(edits), diff, by]);
  return { id: Number(rows[0].id), files: sim.map((f) => f.rel), diff };
}

export async function getProposal(id) {
  const { rows } = await q(`SELECT * FROM repair_proposals WHERE id=$1`, [Number(id)]);
  return rows[0] || null;
}

export async function listProposals(limit = 10) {
  const { rows } = await q(
    `SELECT id, status, title, created_at, decided_at FROM repair_proposals ORDER BY id DESC LIMIT $1`, [limit]);
  return rows;
}

async function testSuite() {
  try {
    const { stdout, stderr } = await run(process.execPath, ['tests/run.js'], { cwd: ROOT, timeout: 240_000, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, failed: 0, tail: String(stdout + stderr).split('\n').slice(-12).join('\n') };
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || ''));
    const m = out.match(/(\d+) of (\d+) suites FAILED/);
    return { code: e.code ?? 1, failed: m ? Number(m[1]) : 1, tail: out.split('\n').slice(-14).join('\n') };
  }
}

function restore(backupDir, rels) {
  for (const rel of rels) {
    const { abs } = safePath(rel);
    fs.copyFileSync(path.join(backupDir, rel), abs);
  }
}

async function gitCommit(rels, message, push) {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return { commit: null, note: 'not a git checkout - files changed on disk only' };
  try {
    await run('git', ['add', '--', ...rels], { cwd: ROOT });
    await run('git', ['commit', '-m', message, '--', ...rels], { cwd: ROOT });
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT });
    let note = 'committed locally';
    if (push) {
      try { await run('git', ['push'], { cwd: ROOT, timeout: 60_000 }); note = 'committed and pushed'; }
      catch (e) { note = `committed locally, push failed: ${String(e.stderr || e.message).split('\n')[0]}`; }
    }
    return { commit: stdout.trim(), note };
  } catch (e) {
    return { commit: null, note: `git commit skipped: ${String(e.stderr || e.message).split('\n')[0]}` };
  }
}

/** Called ONLY from the Telegram /approve handler. */
export async function applyProposal(id, { push = false } = {}) {
  const p = await getProposal(id);
  if (!p) throw new Error(`proposal #${id} not found`);
  if (p.status !== 'pending') throw new Error(`proposal #${id} is ${p.status}, not pending`);

  // Re-validate against what is on disk NOW: the file may have changed since the proposal.
  const sim = simulate(p.edits);
  for (const f of sim) await syntaxCheck(f.rel, f.after);

  const before = await testSuite();

  const dir = path.join(BACKUPS, String(p.id));
  for (const f of sim) {
    fs.mkdirSync(path.dirname(path.join(dir, f.rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.rel), f.before);
  }
  const rels = sim.map((f) => f.rel);
  for (const f of sim) fs.writeFileSync(f.abs, f.after);

  const after = await testSuite();
  const worse = after.failed > before.failed || (before.code === 0 && after.code !== 0);
  if (worse) {
    restore(dir, rels);
    const result = { before, after, reverted: true };
    await q(`UPDATE repair_proposals SET status='failed', decided_at=now(), result=$2::jsonb WHERE id=$1`, [p.id, JSON.stringify(result)]);
    return { ok: false, reverted: true, before, after, files: rels };
  }

  const git = await gitCommit(rels, `agent-fix #${p.id}: ${p.title}`, push);
  const result = { before, after, git };
  await q(`UPDATE repair_proposals SET status='applied', decided_at=now(), result=$2::jsonb WHERE id=$1`, [p.id, JSON.stringify(result)]);
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.writeFileSync(MARKER, JSON.stringify({ id: p.id, rels, at: Date.now() }));
  log.warn(`applied repair #${p.id}: ${rels.join(', ')}`);
  return { ok: true, files: rels, before, after, git, needsRestart: true };
}

export async function rejectProposal(id) {
  const r = await q(`UPDATE repair_proposals SET status='rejected', decided_at=now() WHERE id=$1 AND status='pending' RETURNING id`, [Number(id)]);
  if (!r.rows.length) throw new Error(`proposal #${id} is not pending`);
}

export async function rollbackProposal(id) {
  const p = await getProposal(id);
  if (!p) throw new Error(`proposal #${id} not found`);
  if (p.status !== 'applied') throw new Error(`proposal #${id} is ${p.status}; only applied proposals can be rolled back`);
  const dir = path.join(BACKUPS, String(p.id));
  const rels = [...new Set(p.edits.map((e) => safePath(e.path).rel))];
  for (const rel of rels) if (!fs.existsSync(path.join(dir, rel))) throw new Error(`backup for ${rel} is missing`);
  restore(dir, rels);
  const git = await gitCommit(rels, `revert agent-fix #${p.id}: ${p.title}`, false);
  await q(`UPDATE repair_proposals SET status='rolled_back', decided_at=now() WHERE id=$1`, [p.id]);
  return { files: rels, git, needsRestart: true };
}

/** Exit so a supervisor (scripts/run-guarded.js, systemd, pm2) starts the new code. */
export function restartProcess(delayMs = 800) {
  log.warn('restart requested - exiting for the supervisor to relaunch');
  setTimeout(() => process.exit(0), delayMs);
}

/**
 * If run-guarded.js had to roll an applied repair back because the new code
 * crashed on boot, it leaves a note. Sync the DB and hand the note to the caller
 * (index.js) to send to Telegram. Returns null when nothing happened.
 */
export async function reconcileAfterBoot() {
  const f = path.join(BACKUPS, 'AUTO_ROLLED_BACK.json');
  if (!fs.existsSync(f)) return null;
  let note = null;
  try { note = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ }
  try { fs.unlinkSync(f); } catch { /* ignore */ }
  if (note?.id) {
    await q(`UPDATE repair_proposals SET status='rolled_back', result = COALESCE(result,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
      [Number(note.id), JSON.stringify({ autoRollback: true, reason: note.reason })]).catch(() => {});
  }
  return note;
}
