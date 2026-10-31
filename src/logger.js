const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;

const C = {
  gray: '\x1b[90m', red: '\x1b[31m', yellow: '\x1b[33m',
  green: '\x1b[32m', cyan: '\x1b[36m', reset: '\x1b[0m',
};

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// In-memory ring of recent log lines (all levels, even below LOG_LEVEL) so the
// diagnose tool can answer "why did X not happen" from what the process actually
// logged, instead of guessing. Bounded; nothing is written to disk.
const RING_MAX = 1500;
const ring = [];
function redact(t) {
  return String(t)
    .replace(/(api[-_]?key|secret|token|authorization|sign)(["'\s:=]+)[A-Za-z0-9._\-]{8,}/gi, '$1$2[redacted]')
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[redacted]');
}
export function recentLogs({ level = 'warn', scope = null, grep = null, limit = 60 } = {}) {
  const min = LEVELS[String(level).toLowerCase()] ?? 30;
  const re = grep ? new RegExp(String(grep).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  return ring
    .filter((r) => LEVELS[r.level] >= min && (!scope || r.scope === scope) && (!re || re.test(r.msg)))
    .slice(-Math.max(1, Math.min(300, limit)));
}

function emit(level, color, scope, args) {
  ring.push({ t: new Date().toISOString(), level, scope, msg: redact(args.map((a) => (typeof a === 'string' ? a : (a?.stack || JSON.stringify(a)))).join(' ')).slice(0, 600) });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  if (LEVELS[level] < CURRENT) return;
  const head = `${C.gray}${stamp()}${C.reset} ${color}${level.toUpperCase().padEnd(5)}${C.reset} ${C.cyan}[${scope}]${C.reset}`;
  console.log(head, ...args);
}

export function createLogger(scope) {
  return {
    debug: (...a) => emit('debug', C.gray, scope, a),
    info: (...a) => emit('info', C.green, scope, a),
    warn: (...a) => emit('warn', C.yellow, scope, a),
    error: (...a) => emit('error', C.red, scope, a),
  };
}

export const log = createLogger('core');
