#!/usr/bin/env node
/**
 * Database-only diagnosis, for when a deploy crashes and `doctor` cannot even
 * start because the exchange/AI/Telegram keys are not the problem.
 *
 *   npm run db:check
 *
 * Safe to run inside a Railway shell (`railway run npm run db:check`): it
 * prints no secrets, writes nothing, and says which of DNS, TCP, TLS, auth or
 * permissions is the one that broke.
 */
import 'dotenv/config';
import net from 'node:net';
import dns from 'node:dns/promises';
import {
  URL_ENV_KEYS, isPrivateHost, parseTarget, probeSsl, redactUrl,
  resolveDatabaseUrl, sslLabel, sslPolicy, validateUrl, explainDbError,
} from '../src/db/connection.js';

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const note = (m) => console.log(`     ${m}`);
// This *is* the step-by-step diagnosis, and it already printed the url above.
const useful = (h) => !/npm run db:check|^url: /.test(h);
const notes = (list) => { for (const h of list || []) if (useful(h)) note(`→ ${h}`); };

console.log('🩺 database check\n══════════════════════════════');

// 1 ───────────────────────────────────────────────────────────── the variable
console.log('\n1. Connection string');
const { url, source } = resolveDatabaseUrl(process.env);
const present = URL_ENV_KEYS.filter((k) => process.env[k]);
console.log(`     env vars present: ${present.length ? present.join(', ') : 'none'}`);

if (process.env.RAILWAY_ENVIRONMENT) {
  note(`platform: Railway (env ${process.env.RAILWAY_ENVIRONMENT}, service ${process.env.RAILWAY_SERVICE_NAME || '?'})`);
}

if (!url) {
  bad('no connection string found in the environment');
  notes(explainDbError(new Error('missing'), { url: '' }).hints);
  process.exit(1);
}
const problems = validateUrl(url, source);
if (problems.length) {
  bad(problems[0]);
  for (const p of problems.slice(1)) note(`→ ${p}`);
  process.exit(1);
}
ok(`${redactUrl(url)} (from ${source})`);

const t = parseTarget(url);
const policy = sslPolicy(url);
note(`host ${t.host}:${t.port} · db ${t.database} · user ${t.user || '(none)'} · ${isPrivateHost(t.host) ? 'private network' : 'public'}`);
note(`ssl plan: ${sslLabel(policy.ssl)} — ${policy.reason}${policy.explicit ? ' (pinned)' : ''}`);

// 2 ─────────────────────────────────────────────────────────────────── DNS
console.log('\n2. DNS');
let addrs = [];
try {
  addrs = await dns.lookup(t.host, { all: true });
  ok(addrs.map((a) => `${a.address} (IPv${a.family})`).join(', '));
  if (addrs.every((a) => a.family === 6)) note('IPv6 only — normal for Railway private networking');
} catch (e) {
  bad(`${e.code || e.message} — "${t.host}" does not resolve here`);
  notes(explainDbError(e, { url, source }).hints);
  process.exit(1);
}

// 3 ─────────────────────────────────────────────────────────────────── TCP
console.log('\n3. TCP');
const reachable = await new Promise((resolve) => {
  const s = net.connect({ host: t.host, port: Number(t.port) });
  s.setTimeout(8000);
  const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
  s.once('connect', () => done(true));
  s.once('timeout', () => done('timeout'));
  s.once('error', (e) => done(e.code || e.message));
});
if (reachable === true) ok(`${t.host}:${t.port} accepts connections`);
else {
  bad(`cannot reach ${t.host}:${t.port} (${reachable})`);
  const e = new Error(String(reachable));
  e.code = reachable === 'timeout' ? 'ETIMEDOUT' : reachable;
  notes(explainDbError(e, { url, source }).hints);
  process.exit(1);
}

// 4 ─────────────────────────────────────────────────────────────────── TLS
console.log('\n4. TLS support (Postgres SSLRequest handshake)');
const supportsSsl = await probeSsl(t.host, t.port);
if (supportsSsl === true) ok('server offers TLS');
else if (supportsSsl === false) {
  ok('server speaks plain TCP (no TLS) — typical for a private/internal database');
  if (policy.pinned) {
    bad(`${policy.reason} demands a verified certificate this server cannot present`);
    note('→ verify-ca/verify-full is never downgraded automatically. Use sslmode=require, or drop it.');
  } else if (policy.ssl !== false) {
    warn(`your URL says ${policy.reason} — overridden automatically, TLS will be turned off`);
    note('→ tidy it up by removing sslmode from DATABASE_URL for this private host');
  }
} else warn('could not determine — the driver will negotiate and correct itself');

// 5 ───────────────────────────────────────────────── connect for real, via pg
console.log('\n5. Authentication & permissions');
const { connect, q, close, dbInfo } = await import('../src/db/index.js');
try {
  await connect({ attempts: 3, baseDelayMs: 500 });
  const i = dbInfo();
  ok(`${i.server} — db ${i.database} as ${i.user}, ssl ${i.ssl}`);

  const { rows } = await q("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create");
  rows[0].can_create ? ok('can CREATE in schema public') : bad('no CREATE permission — migrations will fail');

  const { rows: tbl } = await q(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  tbl.length
    ? ok(`${tbl.length} table(s): ${tbl.map((r) => r.tablename).join(', ')}`)
    : warn('no tables yet — run `npm run migrate`');

  console.log('\n══════════════════════════════\n✅ database is reachable and usable');
  await close();
  process.exit(0);
} catch (e) {
  bad(e.message);
  notes(e.hints);
  console.log('\n══════════════════════════════\n❌ database check failed');
  await close();
  process.exit(1);
}
