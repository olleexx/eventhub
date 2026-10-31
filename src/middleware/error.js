import { fileURLToPath } from 'node:url';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { config } from '../config/env.js';

export function notFoundHandler(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  }
  res.status(404).sendFile('404.html', { root: fileURLToPath(new URL('../../public', import.meta.url)) });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong. Please try again.';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err?.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400; code = 'BAD_JSON'; message = 'Malformed JSON body';
  } else if (err?.code === 'LIMIT_FILE_SIZE') {
    status = 413; code = 'FILE_TOO_LARGE'; message = 'File is too large';
  } else if (err?.code === 'P2002') {
    status = 409; code = 'DUPLICATE'; message = 'That record already exists';
  } else if (err?.code === 'P2025') {
    status = 404; code = 'NOT_FOUND'; message = 'Record not found';
  }

  if (status >= 500) log.error('request_failed', { path: req.path, method: req.method, userId: req.user?.id, err });

  if (!req.path.startsWith('/api/') && req.accepts('html') && status >= 400) {
    return res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><title>Error</title><body style="font-family:system-ui;padding:3rem"><h1>${status}</h1><p>${String(message).replace(/[<>&]/g, '')}</p><a href="/">Home</a>`);
  }
  res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}), ...(config.isProd ? {} : status >= 500 ? { debug: err?.message } : {}) } });
}