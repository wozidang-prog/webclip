import { config } from '../config.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };
const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

const COLORS = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta && Object.keys(meta).length ? meta : {}),
  };
  const out = process.stdout;
  const text = `${COLORS[level] ?? ''}${line.t} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${
    meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
  }`;
  out.write(text + '\n');
}

export const logger = {
  trace: (m, meta) => emit('trace', m, meta),
  debug: (m, meta) => emit('debug', m, meta),
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
  child(bindings = {}) {
    const wrap = (level) => (m, meta = {}) => emit(level, m, { ...bindings, ...meta });
    return {
      trace: wrap('trace'),
      debug: wrap('debug'),
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
    };
  },
};
