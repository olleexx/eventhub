import { config } from '../config/env.js';

// Minimal structured logger. Never log secrets: values for these keys are redacted.
const REDACT = /((password|secret|token|authorization|api[_-]?key|cookie)$|^code$)/i; // exact key "code" is a ticket code; errorCode etc. stay visible

function scrub(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: config.isProd ? undefined : value.stack };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.test(k) ? '[redacted]' : scrub(v, depth + 1);
  return out;
}

function emit(level, msg, meta) {
  if (config.isTest && level !== 'error') return;
  const line = { t: new Date().toISOString(), level, msg, ...(meta ? { meta: scrub(meta) } : {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

export const log = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};