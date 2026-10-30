/**
 * Deploy-time database failures, pinned down.
 *
 * The important case: a fake Postgres that refuses TLS — exactly how Railway's
 * private `postgres.railway.internal` behaves — and a connection string that
 * asks for TLS anyway. That combination used to throw "The server does not
 * support SSL connections" and kill the container on boot.
 */
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  cleanUrl, resolveDatabaseUrl, parseTarget, redactUrl, isPrivateHost,
  sslPolicy, sslLabel, sslCorrection, isRetryable, probeSsl, validateUrl,
  explainDbError, stripSslParams,
} from '../src/db/connection.js';

const RAILWAY = 'postgresql://postgres:secret@postgres.railway.internal:5432/railway';
const NEON = 'postgresql://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb?sslmode=require';

let passed = 0;
const check = (cond, msg) => { assert.ok(cond, msg); passed++; };

console.log('=== database transport ===\n');

console.log('connection string resolution');
check(cleanUrl(`psql "${RAILWAY}"`) === RAILWAY, 'cleanUrl strips psql and quotes');
check(cleanUrl(`  ${RAILWAY}  `) === RAILWAY, 'cleanUrl trims whitespace');
check(cleanUrl(undefined) === '', 'cleanUrl handles undefined');
check(resolveDatabaseUrl({ DATABASE_URL: RAILWAY, DATABASE_PUBLIC_URL: NEON }).source === 'DATABASE_URL',
  'DATABASE_URL is preferred');
check(resolveDatabaseUrl({ DATABASE_PUBLIC_URL: NEON }).source === 'DATABASE_PUBLIC_URL',
  'DATABASE_PUBLIC_URL is a fallback');
check(resolveDatabaseUrl({}).url === '', 'no URL resolves to empty');
{
  const { url } = resolveDatabaseUrl({
    PGHOST: 'containers-us-west-1.railway.app', PGUSER: 'postgres',
    PGPASSWORD: 'p@ss word', PGPORT: '7431', PGDATABASE: 'railway',
  });
  const t = parseTarget(url);
  check(t.host === 'containers-us-west-1.railway.app', 'PGHOST assembles a URL');
  check(t.port === '7431', 'PGPORT survives');
  check(url.includes('p%40ss%20word'), 'password is percent-encoded');
}
check(!redactUrl(RAILWAY).includes('secret'), 'redactUrl never leaks the password');
check(!redactUrl(NEON).includes('u:p'), 'redactUrl removes user:password');

console.log('\nTLS policy');
for (const h of ['postgres.railway.internal', 'localhost', '127.0.0.1', '10.0.0.4',
  '172.20.1.9', '192.168.1.10', 'fd12:3456::1', 'db', 'pg.flycast']) {
  check(isPrivateHost(h), `${h} is private`);
}
for (const h of ['ep-cool-123.eu-central-1.aws.neon.tech', 'db.example.com',
  'aws-0-eu-west-2.pooler.supabase.com', 'containers-us-west-1.railway.app']) {
  check(!isPrivateHost(h), `${h} is public`);
}
check(sslPolicy(RAILWAY, {}).ssl === false, 'private host defaults to plain TCP');
check(sslPolicy(NEON, {}).ssl.rejectUnauthorized === false, 'public host defaults to TLS without verification');
check(sslPolicy(`${RAILWAY}?sslmode=disable`, {}).ssl === false, 'sslmode=disable is honoured');
check(sslPolicy('postgresql://u:p@db.example.com/x?sslmode=verify-full', {}).ssl.rejectUnauthorized === true,
  'verify-full verifies the certificate');
check(sslPolicy(`${RAILWAY}?sslmode=require`, {}).pinned === false, 'sslmode=require is correctable');
check(sslPolicy('postgresql://u:p@db.example.com/x?sslmode=verify-full', {}).pinned === true,
  'verify-* is pinned');
check(sslPolicy('postgresql://u:p@db.example.com/x', { PGSSLMODE: 'disable' }).ssl === false,
  'PGSSLMODE is honoured');
check(sslLabel(false) === 'off', 'sslLabel off');
check(sslLabel({ rejectUnauthorized: false }) === 'on (unverified cert)', 'sslLabel unverified');
check(sslLabel({ rejectUnauthorized: true }) === 'on (verified)', 'sslLabel verified');

console.log('\nsslmode must not overrule the explicit option');
{
  const s = stripSslParams(`${NEON}&channel_binding=require&application_name=aria`);
  check(!s.includes('sslmode'), 'sslmode removed');
  check(s.includes('channel_binding=require'), 'other params survive');
  check(parseTarget(s).database === 'neondb', 'database name intact');
  check(stripSslParams(RAILWAY) === RAILWAY, 'a URL without sslmode is unchanged');
}


console.log('\nerror interpretation');
check(sslCorrection(new Error('The server does not support SSL connections')) === 'off',
  'plain-TCP server means turn TLS off');
check(sslCorrection(new Error('no pg_hba.conf entry for host "1.2.3.4", SSL off')) === 'on',
  'server requiring TLS means turn it on');
check(sslCorrection(new Error('password authentication failed')) === null, 'auth errors are not transport errors');
check(isRetryable({ code: 'ENOTFOUND' }) === true, 'DNS failures retry');
check(isRetryable({ code: '28P01' }) === false, 'bad password does not retry');
check(validateUrl('', null)[0].includes('empty'), 'empty URL is caught before dialling');
check(validateUrl(RAILWAY).length === 0, 'a valid URL passes validation');
{
  const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND postgres.railway.internal'), { code: 'ENOTFOUND' });
  const { headline, hints } = explainDbError(dnsErr, { url: RAILWAY, source: 'DATABASE_URL' });
  check(/ENOTFOUND/.test(headline), 'headline names the failure');
  check(hints.join('\n').includes('private networking') || hints.join('\n').includes('DNS'),
    'hints explain a Railway private-host DNS failure');
}

// ── the regression: a TLS-less server + a URL demanding TLS ────────────────

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const msg = (t, body) => Buffer.concat([Buffer.from(t), int32(body.length + 4), body]);
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const ready = () => msg('Z', Buffer.from('I'));
const rowDescription = () => {
  const field = (name) => Buffer.concat([
    cstr(name), int32(0), Buffer.from([0, 0]), int32(25), Buffer.from([0xff, 0xff]), int32(-1), Buffer.from([0, 0]),
  ]);
  return msg('T', Buffer.concat([Buffer.from([0, 3]), field('db'), field('user'), field('version')]));
};
const dataRow = () => {
  const col = (v) => Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)]);
  return msg('D', Buffer.concat([Buffer.from([0, 3]), col('railway'), col('postgres'), col('PostgreSQL 16.4 on x86_64')]));
};

function fakePostgres({ tls = false } = {}) {
  const server = net.createServer((sock) => {
    let started = false;
    sock.on('data', (buf) => {
      if (!started && buf.length === 8 && buf.readInt32BE(4) === 80877103) {
        sock.write(Buffer.from(tls ? 'S' : 'N'));
        return;
      }
      if (!started) {
        started = true;
        sock.write(Buffer.concat([msg('R', int32(0)), msg('K', Buffer.concat([int32(1), int32(2)])), ready()]));
        return;
      }
      if (buf[0] === 0x51) sock.write(Buffer.concat([rowDescription(), dataRow(), msg('C', cstr('SELECT 1')), ready()]));
      if (buf[0] === 0x58) sock.end();
    });
    sock.on('error', () => {});
  });
  return server;
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

console.log('\nfake Postgres (TLS refused) + sslmode=require must connect');
{
  const server = fakePostgres({ tls: false });
  const port = await listen(server);
  process.env.DATABASE_URL = `postgresql://postgres:secret@127.0.0.1:${port}/railway?sslmode=require`;
  process.env.DB_CONNECT_ATTEMPTS = '2';

  const db = await import('../src/db/index.js');
  try {
    const info = await db.connect({ attempts: 2, baseDelayMs: 20 });
    check(info.connected === true, 'connect() succeeds');
    check(info.ssl === 'off', 'transport downgraded to plain TCP');
    check(info.database === 'railway', 'database reported');
  } finally {
    await db.close();
    server.close();
  }
}

console.log('\nprobeSsl reports what the server offers');
{
  const plain = fakePostgres({ tls: false });
  const secure = fakePostgres({ tls: true });
  const [p1, p2] = [await listen(plain), await listen(secure)];
  check(await probeSsl('127.0.0.1', p1) === false, 'probe sees no TLS');
  check(await probeSsl('127.0.0.1', p2) === true, 'probe sees TLS');
  check(await probeSsl('127.0.0.1', 1) === null, 'unreachable server is null');
  plain.close();
  secure.close();
}

console.log(`\npassed ${passed}`);
process.exit(0);
