/**
 * Structured JSON logger (prompt §48).
 * Levels: DEBUG < INFO < WARN < ERROR < CRITICAL.
 * Secrets are redacted by key name before anything is written.
 */
const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, CRITICAL: 50 };
const SECRET_KEYS = /pass(word)?|token|secret|private.?key|authorization|cookie/i;

let threshold = LEVELS.INFO;
export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.INFO;
}

export function redact(value, depth = 0) {
  if (depth > 5 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function write(level, event, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) });
  (LEVELS[level] >= LEVELS.ERROR ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (e, f) => write('DEBUG', e, f),
  info: (e, f) => write('INFO', e, f),
  warn: (e, f) => write('WARN', e, f),
  error: (e, f) => write('ERROR', e, f),
  critical: (e, f) => write('CRITICAL', e, f),
};
