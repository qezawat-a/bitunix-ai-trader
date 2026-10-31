/**
 * Where the database is, how to speak to it, and what to tell the human when
 * it will not answer.
 *
 * Running locally you have one Postgres and one URL, so none of this matters.
 * On a PaaS it does: Railway hands you a *private* Postgres on
 * `postgres.railway.internal` that speaks plain TCP and will hang up if you
 * open with a TLS handshake, while Neon/Supabase/RDS are public and demand
 * exactly that handshake. Hard-coding either one breaks the other, so the
 * transport is *detected* instead of assumed, and every failure is turned
 * into a sentence that names the fix.
 */

/** Env vars that may carry a connection string, best first. */
export const URL_ENV_KEYS = [
  'DATABASE_URL',          // the standard, and what Railway injects for the private network
  'DATABASE_PRIVATE_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'PG_URL',
  'NEON_DATABASE_URL',
  'DATABASE_PUBLIC_URL',   // Railway's TCP-proxy URL — works everywhere, costs egress
];

const QUOTED = /^(['"])([\s\S]*)\1$/;
const PSQL_PREFIX = /^psql\s+/i;
/** `${{Postgres.DATABASE_URL}}` / `${DATABASE_URL}` left verbatim = the reference never resolved. */
const UNRESOLVED_REF = /\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
/** Hosts/credentials straight out of .env.example. */
const PLACEHOLDERS = [/ep-xxx/i, /\buser:pass@/i, /[<>]/, /your[-_]?(password|host|db)/i, /xxxxx/i];

const SSL_OFF = new Set(['disable', 'off', 'false', '0', 'no', 'none']);
const SSL_ON = new Set(['require', 'prefer', 'allow', 'true', '1', 'yes', 'on']);
const SSL_VERIFY = new Set(['verify-ca', 'verify-full']);

/**
 * Strip the things people actually paste into a dashboard variable box: the
 * `psql ` the copy button prepends, and the quotes around it.
 */
export function cleanUrl(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  v = v.replace(PSQL_PREFIX, '').trim();
  const m = v.match(QUOTED);
  if (m) v = m[2].trim();
  return v;
}

/** First usable connection string found in `env`, already cleaned. */
export function resolveDatabaseUrl(env = process.env) {
  for (const key of URL_ENV_KEYS) {
    const v = cleanUrl(env[key]);
    if (v) return { url: v, source: key };
  }
  // Discrete PG* parts — how Railway's "add all variables" and Docker compose
  // usually wire a database up.
  const host = cleanUrl(env.PGHOST);
  const user = cleanUrl(env.PGUSER);
  if (host && user) {
    const pass = encodeURIComponent(cleanUrl(env.PGPASSWORD));
    const port = cleanUrl(env.PGPORT) || '5432';
    const dbName = cleanUrl(env.PGDATABASE) || user;
    const auth = pass ? `${encodeURIComponent(user)}:${pass}` : encodeURIComponent(user);
    return { url: `postgresql://${auth}@${host}:${port}/${dbName}`, source: 'PGHOST/PGUSER/…' };
  }
  return { url: '', source: null };
}

/** Parsed view of a connection string, or `null` if it will not parse. */
export function parseTarget(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return {
      host: decodeURIComponent(u.hostname),
      port: u.port || '5432',
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || '',
      user: decodeURIComponent(u.username || ''),
      hasPassword: Boolean(u.password),
      params: u.searchParams,
    };
  } catch {
    return null;
  }
}

/** `postgresql://user:***@host:5432/db` — safe to put in a log or a chat. */
export function redactUrl(url) {
  if (!url) return '(empty)';
  const t = parseTarget(url);
  if (!t) return String(url).replace(/:\/\/[^@/]*@/, '://***@');
  const auth = t.user ? `${t.user}${t.hasPassword ? ':***' : ''}@` : '';
  return `postgresql://${auth}${t.host}:${t.port}/${t.database}`;
}

/**
 * Loopback, RFC1918, IPv6 ULA (Railway's private network lives on `fd00::/8`),
 * `*.internal` service DNS, or a bare hostname like `postgres` in a compose
 * network. None of these terminate TLS.
 */
export function isPrivateHost(host) {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;                 // fc00::/7 unique-local
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h.endsWith('.railway.internal') || h.endsWith('.flycast')) return true;
  if (!h.includes('.') && !h.includes(':')) return true;         // docker/compose service name
  return false;
}

/**
 * What TLS setting to open with.
 *
 * An explicit `sslmode=` (in the URL, or `PGSSLMODE`/`DATABASE_SSL` in the
 * env) always wins and is treated as final. With nothing explicit we guess
 * from the host and stay ready to be corrected by the server itself — see
 * `sslCorrection`.
 */
export function sslPolicy(url, env = process.env) {
  const t = parseTarget(url);
  const fromUrl = (t?.params.get('sslmode') || t?.params.get('ssl') || '').toLowerCase();
  const fromEnv = String(env.PGSSLMODE ?? env.DATABASE_SSL ?? '').trim().toLowerCase();
  const mode = fromUrl || fromEnv;
  const where = fromUrl ? 'sslmode in DATABASE_URL' : 'PGSSLMODE/DATABASE_SSL';

  if (mode) {
    // verify-ca/verify-full are a security assertion, not a hint: they are the
    // one setting we will never quietly downgrade, even if the server asks.
    if (SSL_VERIFY.has(mode)) {
      return { ssl: { rejectUnauthorized: true }, reason: `${where}=${mode}`, explicit: true, pinned: true };
    }
    if (SSL_OFF.has(mode)) return { ssl: false, reason: `${where}=${mode}`, explicit: true, pinned: false };
    if (SSL_ON.has(mode)) {
      // Railway/Supabase/RDS all present certificates that chain to a root the
      // container does not ship, so `require` means "encrypt", not "verify" —
      // which is exactly what libpq's `require` means too.
      return { ssl: { rejectUnauthorized: false }, reason: `${where}=${mode}`, explicit: true, pinned: false };
    }
  }

  if (t && isPrivateHost(t.host)) {
    return { ssl: false, reason: `private host ${t.host} — plain TCP`, explicit: false, pinned: false };
  }
  return {
    ssl: { rejectUnauthorized: false },
    reason: 'public host — TLS without cert verification',
    explicit: false,
    pinned: false,
  };
}

export const sslLabel = (ssl) =>
  ssl === false ? 'off' : ssl?.rejectUnauthorized ? 'on (verified)' : 'on (unverified cert)';

/**
 * Remove `sslmode`/`ssl` from the query string before handing the URL to the
 * driver.
 *
 * node-postgres merges `parse(connectionString)` *over* the explicit options
 * (`Object.assign({}, config, parse(...))`), so an `sslmode` in the URL wins
 * every argument we make — our `ssl` setting would be silently discarded.
 * Worse, pg-connection-string currently maps `sslmode=require` to a verifying
 * TLS context, so the `?sslmode=require` that every provider puts in its
 * example URL demands a certificate chain that Railway's proxy, Supabase's
 * pooler and most self-hosted servers cannot present.
 *
 * We already read that parameter in `sslPolicy`. Taking it out of the string
 * leaves exactly one source of truth.
 */
export function stripSslParams(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('sslmode') && !u.searchParams.has('ssl')) return url;
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Ask the server, over one throwaway socket, whether it speaks TLS.
 *
 * This is the Postgres startup handshake: send the 8-byte SSLRequest and read
 * one byte back — `S` yes, `N` no. Cheaper and far more reliable than guessing
 * from the hostname, and it is why a Railway private database and a Neon
 * database both just work with no configuration.
 *
 * @returns {Promise<boolean|null>} null when the server could not be reached
 */
export function probeSsl(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    // Imported lazily so this module stays usable in non-node contexts/tests.
    import('node:net').then(({ default: net }) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };

      const sock = net.connect({ host, port: Number(port) || 5432 });
      sock.setTimeout(timeoutMs);

      sock.once('connect', () => {
        const buf = Buffer.alloc(8);
        buf.writeInt32BE(8, 0);
        buf.writeInt32BE(80877103, 4);   // (1234 << 16) | 5679
        sock.write(buf);
      });
      sock.once('data', (d) => finish(d[0] === 0x53));   // 'S'
      sock.once('timeout', () => finish(null));
      sock.once('error', () => finish(null));
      sock.once('close', () => finish(null));
    }).catch(() => resolve(null));
  });
}

/**
 * Does this failure mean "you chose the wrong transport"?
 * @returns {'off'|'on'|null} the setting to switch to, or null
 */
export function sslCorrection(err) {
  const m = String(err?.message || '');
  if (/does not support SSL/i.test(m)) return 'off';
  if (/SSL.*(is )?required|no encryption|pg_hba\.conf.*(no encryption|SSL off)/i.test(m)) return 'on';
  if (/self.signed certificate|unable to verify the first certificate|certificate has expired|ERR_TLS/i.test(m)) return 'on';
  if (err?.code === 'EPROTO' || err?.code === 'ERR_SSL_WRONG_VERSION_NUMBER') return 'off';
  return null;
}

const RETRYABLE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL',
  '57P03',  // cannot_connect_now — server still starting
  '53300',  // too_many_connections
  '08006', '08001', '08004',
]);

/** Worth waiting and trying again (network/boot), vs. a config mistake. */
export function isRetryable(err) {
  if (!err) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  return /timeout|terminated unexpectedly|Connection terminated|socket hang up/i.test(String(err.message || ''));
}

/**
 * Turn a driver error into an explanation a human can act on.
 * @returns {{ headline: string, hints: string[] }}
 */
export function explainDbError(err, { url = '', source = null, ssl = undefined } = {}) {
  const t = parseTarget(url);
  const host = t?.host || '(unknown host)';
  const railway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID || process.env.RAILWAY_PROJECT_ID);
  const code = err?.code ? ` [${err.code}]` : '';
  const hints = [];
  const headline = `database unreachable${code}: ${err?.message || err}`;

  const on = (...lines) => hints.push(...lines);

  if (!url) {
    return {
      headline: 'DATABASE_URL is not set',
      hints: [
        'Set DATABASE_URL on the *service*, not only as a shared/project variable.',
        railway
          ? 'Railway: service → Variables → New Variable → Add Reference → pick your Postgres → DATABASE_URL. A reference typed by hand as text does not resolve.'
          : 'Copy the connection string from your provider (Neon: "Connection string", Railway: Postgres → Variables).',
        'Then redeploy — variables are baked in at deploy time.',
      ],
    };
  }

  if (/does not support SSL/i.test(String(err?.message))) {
    on(
      `${host} speaks plain TCP, but the client opened with TLS.`,
      'This is now auto-detected. If you pinned it, remove sslmode=require (or set DATABASE_SSL=disable) for a private/internal host.',
    );
  } else if (sslCorrection(err) === 'on') {
    on(`${host} requires TLS. Append ?sslmode=require to DATABASE_URL, or set DATABASE_SSL=require.`);
  }

  switch (err?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      on(`DNS has no record for "${host}".`);
      if (host.endsWith('.railway.internal')) {
        on(
          'Private networking only resolves *inside* the same Railway project+environment — it never resolves from your laptop or during the build.',
          'It also needs a few seconds after the container starts; this app now retries (DB_CONNECT_ATTEMPTS, default 10).',
          'If the app and the database are in different projects/environments, use Postgres → Variables → DATABASE_PUBLIC_URL instead.',
          'Private networking is IPv6-only. If it keeps failing, set NODE_OPTIONS=--dns-result-order=ipv6first.',
        );
      } else {
        on('Check the hostname for typos, and that the value is the connection string and not the example from .env.example.');
      }
      break;
    case 'ECONNREFUSED':
      on(
        `Nothing is listening on ${host}:${t?.port || '5432'}.`,
        host === 'localhost' || host.startsWith('127.')
          ? 'The URL points at localhost — inside a container that is the container itself, not your database. Use the provider\'s hostname.'
          : 'Check the port, and that the database service is actually running (Railway: the Postgres service must be deployed, not just created).',
      );
      break;
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      on(
        `Reached DNS but not the server (${host}:${t?.port || '5432'}).`,
        'Usually an IP allow-list: Neon/Supabase/RDS must allow the deploy platform, or be set to allow all.',
        'Railway private hosts are IPv6-only — NODE_OPTIONS=--dns-result-order=ipv6first if the platform prefers A records.',
      );
      break;
    case '28P01':
    case '28000':
      on(
        'The server answered — the password or user is wrong.',
        'Re-copy the URL; a rotated database password leaves stale copies behind.',
        'If the password contains @ : / ? # or %, it must be percent-encoded inside the URL (@ → %40).',
      );
      break;
    case '3D000':
      on(`Database "${t?.database}" does not exist on ${host}. Railway's default database is "railway", Neon's is "neondb".`);
      break;
    case '42501':
    case '42P01':
      on('Connected, but this user may not create tables. Use the owner role, or grant CREATE on the schema.');
      break;
    case '53300':
      on('Connection limit reached. Lower DB_POOL_MAX (default 5), or resume/resize the database.');
      break;
    default:
      break;
  }

  if (/Client has encountered a connection error|Connection terminated/i.test(String(err?.message))) {
    on('Neon scale-to-zero can drop the first connection; the retry loop covers this.');
  }

  on(`url: ${redactUrl(url)}${source ? ` (from ${source})` : ''}`);
  if (ssl !== undefined) on(`ssl: ${sslLabel(ssl)}`);
  on('Run `npm run db:check` for a step-by-step diagnosis (it needs no other keys).');

  return { headline, hints };
}

/**
 * Reasons this string can never connect, found before we dial. Catching these
 * up front replaces a confusing driver error with the actual mistake.
 */
export function validateUrl(url, source = null) {
  const problems = [];
  if (!url) {
    problems.push('DATABASE_URL is empty.');
    return problems;
  }
  if (UNRESOLVED_REF.test(url)) {
    problems.push(
      `DATABASE_URL still contains an unresolved variable reference (${url.match(UNRESOLVED_REF)[0]}).`,
      'Railway resolves ${{Service.VAR}} only when it is added with "Add Reference" and the service name matches exactly.',
    );
    return problems;
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    problems.push(`DATABASE_URL must start with postgresql:// — got "${url.slice(0, 24)}…".`);
    return problems;
  }
  const t = parseTarget(url);
  if (!t) {
    problems.push(
      'DATABASE_URL is not a parseable URL.',
      'Most often the password contains @ : / ? # or % un-encoded. Percent-encode it (@ → %40, # → %23).',
    );
    return problems;
  }
  if (!t.host) problems.push('DATABASE_URL has no host.');
  if (!t.database) problems.push('DATABASE_URL has no database name (the part after the last "/").');
  for (const p of PLACEHOLDERS) {
    if (p.test(url)) {
      problems.push(`DATABASE_URL still looks like the example value from .env.example (matched ${p}).`);
      break;
    }
  }
  if (source && source !== 'DATABASE_URL' && problems.length === 0) return problems;
  return problems;
}
