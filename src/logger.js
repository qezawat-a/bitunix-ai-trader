const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;

const C = {
  gray: '\x1b[90m', red: '\x1b[31m', yellow: '\x1b[33m',
  green: '\x1b[32m', cyan: '\x1b[36m', reset: '\x1b[0m',
};

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, color, scope, args) {
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
