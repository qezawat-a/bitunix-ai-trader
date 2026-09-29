/**
 * The deploy-time database failures, pinned down.
 *
 *   node --test tests/
 *
 * The last test is the one that matters: a fake Postgres that refuses TLS —
 * exactly how Railway's private `postgres.railway.internal` behaves — and a
 * connection string that asks for TLS anyway. That combination used to throw
 * "The server does not support SSL connections" and kill the container on
 * boot; here it must connect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import pg from 'pg';
import {
  cleanUrl, resolveDatabaseUrl, parseTarget, redactUrl, isPrivateHost,
  sslPolicy, sslLabel, sslCorrection, isRetryable, probeSsl, validateUrl,
  explainDbError, stripSslParams,
} from '../src/db/connection.js';

const RAILWAY = 'postgresql://postgres:secret@postgres.railway.internal:5432/railway';
const NEON = 'postgresql://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb?sslmode=require';

// ── the connection string ───────────────────────────────────────────────────

test('cleanUrl strips what dashboards put on the clipboard', () => {
  assert.equal(cleanUrl(`psql "${RAILWAY}"`), RAILWAY);
  assert.equal(cleanUrl(`'${RAILWAY}'`), RAILWAY);
  assert.equal(cleanUrl(`  ${RAILWAY}  `), RAILWAY);
  assert.equal(cleanUrl(undefined), '');
});

test('resolveDatabaseUrl prefers DATABASE_URL, then falls back', () => {
  assert.deepEqual(resolveDatabaseUrl({ DATABASE_URL: RAILWAY, DATABASE_PUBLIC_URL: NEON }),
    { url: RAILWAY, source: 'DATABASE_URL' });
  assert.equal(resolveDatabaseUrl({ DATABASE_PUBLIC_URL: NEON }).source, 'DATABASE_PUBLIC_URL');
  assert.equal(resolveDatabaseUrl({}).url, '');
});

test('resolveDatabaseUrl assembles the discrete PG* parts', () => {
  const { url } = resolveDatabaseUrl({
    PGHOST: 'containers-us-west-1.railway.app', PGUSER: 'postgres',
    PGPASSWORD: 'p@ss word', PGPORT: '7431', PGDATABASE: 'railway',
  });
  const t = parseTarget(url);
  assert.equal(t.host, 'containers-us-west-1.railway.app');
  assert.equal(t.port, '7431');
  assert.equal(t.database, 'railway');
  assert.ok(url.includes('p%40ss%20word'), 'password must be percent-encoded');
});

test('redactUrl never leaks the password', () => {
  assert.equal(redactUrl(RAILWAY), 'postgresql://postgres:***@postgres.railway.internal:5432/railway');
  assert.ok(!redactUrl(NEON).includes('p@'));
});

// ── which hosts terminate TLS ───────────────────────────────────────────────

test('isPrivateHost knows the networks that do not do TLS', () => {
  for (const h of ['postgres.railway.internal', 'localhost', '127.0.0.1', '10.0.0.4',
    '172.20.1.9', '192.168.1.10', 'fd12:3456::1', 'db', 'pg.flycast']) {
    assert.ok(isPrivateHost(h), `${h} should be private`);
  }
  for (const h of ['ep-cool-123.eu-central-1.aws.neon.tech', 'db.example.com',
    'aws-0-eu-west-2.pooler.supabase.com', 'containers-us-west-1.railway.app']) {
    assert.ok(!isPrivateHost(h), `${h} should be public`);
  }
});

test('sslPolicy: Railway private = plain TCP, Neon = TLS', () => {
  assert.equal(sslPolicy(RAILWAY, {}).ssl, false);
  assert.deepEqual(sslPolicy(NEON, {}).ssl, { rejectUnauthorized: false });
});

test('sslPolicy honours an explicit sslmode, and PGSSLMODE', () => {
  assert.equal(sslPolicy(`${RAILWAY}?sslmode=disable`, {}).ssl, false);
  assert.deepEqual(sslPolicy('postgresql://u:p@db.example.com/x?sslmode=require', {}).ssl,
    { rejectUnauthorized: false });
  assert.deepEqual(sslPolicy('postgresql://u:p@db.example.com/x?sslmode=verify-full', {}).ssl,
    { rejectUnauthorized: true });
  assert.equal(sslPolicy('postgresql://u:p@db.example.com/x', { PGSSLMODE: 'disable' }).ssl, false);
});

test('only verify-* is pinned — sslmode=require stays correctable', () => {
  assert.equal(sslPolicy(`${RAILWAY}?sslmode=require`, {}).pinned, false);
  assert.equal(sslPolicy('postgresql://u:p@db.example.com/x?sslmode=verify-full', {}).pinned, true);
});

test('stripSslParams removes only the ssl knobs', () => {
  assert.equal(stripSslParams(RAILWAY), RAILWAY);
  const s = stripSslParams(`${NEON}&channel_binding=require&application_name=aria`);
  assert.ok(!s.includes('sslmode'));
  assert.ok(s.includes('channel_binding=require'), 'other params survive');
  assert.ok(s.includes('application_name=aria'));
  assert.equal(parseTarget(s).database, 'neondb', 'database name intact');
});

test('our ssl choice survives the driver, whatever the URL says', () => {
  // pg merges parse(connectionString) OVER the explicit options, and maps
  // sslmode=require to a *verifying* context — both of which we must beat.
  const asIs = new pg.Client({ connectionString: NEON, ssl: { rejectUnauthorized: false } });
  assert.deepEqual(asIs.ssl, {}, 'baseline: the URL wins and demands verification');

  const fixed = new pg.Client({ connectionString: stripSslParams(NEON), ssl: { rejectUnauthorized: false } });
  assert.deepEqual(fixed.ssl, { rejectUnauthorized: false }, 'our setting must win');
  assert.equal(fixed.connectionParameters.database, 'neondb');

  const off = new pg.Client({ connectionString: stripSslParams(`${RAILWAY}?sslmode=require`), ssl: false });
  assert.equal(off.ssl, false);
});

test('sslCorrection reads the server\'s complaint', () => {
  assert.equal(sslCorrection(new Error('The server does not support SSL connections')), 'off');
  assert.equal(sslCorrection(new Error('no pg_hba.conf entry for host "1.2.3.4", SSL off')), 'on');
  assert.equal(sslCorrection(new Error('self-signed certificate in certificate chain')), 'on');
  assert.equal(sslCorrection(new Error('password authentication failed')), null);
});

test('isRetryable separates "wait" from "you typed it wrong"', () => {
  assert.ok(isRetryable(Object.assign(new Error('x'), { code: 'ENOTFOUND' })));
  assert.ok(isRetryable(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })));
  assert.ok(!isRetryable(Object.assign(new Error('x'), { code: '28P01' })));
  assert.ok(!isRetryable(Object.assign(new Error('x'), { code: '3D000' })));
});

// ── refusing to dial a string that cannot work ──────────────────────────────

test('validateUrl catches the mistakes people actually make', () => {
  assert.match(validateUrl('${{Postgres.DATABASE_URL}}')[0], /unresolved variable reference/);
  assert.match(validateUrl('postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb')[0], /example value/);
  assert.match(validateUrl('mysql://u:p@h/db')[0], /must start with postgresql/);
  assert.match(validateUrl('')[0], /empty/);
  assert.deepEqual(validateUrl(RAILWAY), []);
  assert.deepEqual(validateUrl(NEON), []);
});

test('explainDbError names the fix, not the stack', () => {
  const dns = explainDbError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    { url: RAILWAY, source: 'DATABASE_URL' });
  assert.match(dns.hints.join('\n'), /private networking/i);
  assert.match(dns.hints.join('\n'), /DATABASE_PUBLIC_URL/);

  const auth = explainDbError(Object.assign(new Error('password authentication failed'), { code: '28P01' }),
    { url: NEON, source: 'DATABASE_URL' });
  assert.match(auth.hints.join('\n'), /percent-encoded/);

  const none = explainDbError(new Error('missing'), { url: '' });
  assert.match(none.headline, /DATABASE_URL is not set/);

  // never leak the password, in any branch
  for (const r of [dns, auth]) assert.ok(!JSON.stringify(r).includes('secret'));
});

// ── talking to a server that refuses TLS ────────────────────────────────────

/** Minimal Postgres wire server. `tls:false` answers 'N' to the SSLRequest. */
function fakePostgres({ tls = false } = {}) {
  const server = net.createServer((sock) => {
    let started = false;
    sock.on('data', (buf) => {
      if (!started && buf.length === 8 && buf.readInt32BE(4) === 80877103) {
        sock.write(Buffer.from(tls ? 'S' : 'N'));
        return;
      }
      if (!started) {                       // StartupMessage → AuthenticationOk, ReadyForQuery
        started = true;
        sock.write(Buffer.concat([msg('R', int32(0)), msg('K', Buffer.concat([int32(1), int32(2)])), ready()]));
        return;
      }
      if (buf[0] === 0x51) sock.write(Buffer.concat([rowDescription(), dataRow(), commandComplete(), ready()]));
      if (buf[0] === 0x58) sock.end();      // Terminate
    });
    sock.on('error', () => {});
  });
  return server;
}

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const msg = (type, body) => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const ready = () => msg('Z', Buffer.from('I'));
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

function rowDescription() {
  const field = (name) => Buffer.concat([
    cstr(name), int32(0), Buffer.from([0, 0]), int32(25), Buffer.from([0xff, 0xff]), int32(-1), Buffer.from([0, 0]),
  ]);
  return msg('T', Buffer.concat([Buffer.from([0, 3]), field('db'), field('user'), field('version')]));
}
function dataRow() {
  const col = (v) => Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)]);
  return msg('D', Buffer.concat([Buffer.from([0, 3]), col('railway'), col('postgres'), col('PostgreSQL 16.4 on x86_64')]));
}
const commandComplete = () => msg('C', cstr('SELECT 1'));

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('probeSsl reports what the server offers', async () => {
  const noTls = fakePostgres({ tls: false });
  const withTls = fakePostgres({ tls: true });
  const [p1, p2] = [await listen(noTls), await listen(withTls)];
  assert.equal(await probeSsl('127.0.0.1', p1), false);
  assert.equal(await probeSsl('127.0.0.1', p2), true);
  assert.equal(await probeSsl('127.0.0.1', 1), null);       // nothing there
  noTls.close(); withTls.close();
});

test('REGRESSION: a TLS-less server + a URL demanding TLS still connects', async (t) => {
  const server = fakePostgres({ tls: false });
  const port = await listen(server);
  t.after(() => server.close());

  // sslmode=require against a server that has no TLS: the old code sent an
  // SSLRequest, got 'N', and threw "The server does not support SSL
  // connections" — the crash loop this whole module exists to prevent.
  process.env.DATABASE_URL = `postgresql://postgres:secret@127.0.0.1:${port}/railway?sslmode=require`;
  process.env.DB_CONNECT_ATTEMPTS = '2';

  const db = await import(`../src/db/index.js?case=downgrade`);
  const info = await db.connect({ attempts: 2, baseDelayMs: 50 });

  assert.equal(info.connected, true);
  assert.equal(info.ssl, 'off', 'must have downgraded to plain TCP');
  assert.equal(info.database, 'railway');
  await db.pool.end();
});

test('sslLabel is human-readable', () => {
  assert.equal(sslLabel(false), 'off');
  assert.equal(sslLabel({ rejectUnauthorized: false }), 'on (unverified cert)');
  assert.equal(sslLabel({ rejectUnauthorized: true }), 'on (verified)');
});
