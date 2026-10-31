// CSRF protection.
//  * Authenticated sessions: synchroniser token stored on the Session row, sent by the SPA in the
//    X-CSRF-Token header (GET /api/auth/me returns it). Compared in constant time.
//  * Unauthenticated state-changing requests (login, register, guest checkout): require a JSON or
//    multipart content type plus an Origin/Referer that matches APP_URL. Browsers cannot send
//    cross-site JSON with cookies without a CORS preflight, which this API never grants.
//  * Webhooks and cron endpoints are mounted outside this middleware and use their own auth.
import { config } from '../config/env.js';
import { safeEqual } from '../utils/crypto.js';
import { AppError } from '../lib/errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const appOrigin = new URL(config.APP_URL).origin;
const allowedOrigins = new Set([appOrigin, ...String(config.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)]);

function originOk(req) {
  const origin = req.headers.origin;
  if (origin) return allowedOrigins.has(origin);
  const referer = req.headers.referer;
  if (referer) {
    try { return allowedOrigins.has(new URL(referer).origin); } catch { return false; }
  }
  // No Origin/Referer at all: only acceptable for non-browser clients/tests in non-production.
  return !config.isProd;
}

export function csrfProtection(req, res, next) {
  if (SAFE.has(req.method)) return next();
  if (!originOk(req)) return next(new AppError(403, 'CSRF_ORIGIN', 'Cross-site request blocked'));

  if (req.session) {
    const sent = req.get('x-csrf-token');
    if (!sent || !safeEqual(sent, req.session.csrfToken)) {
      return next(new AppError(403, 'CSRF_TOKEN', 'Missing or invalid CSRF token'));
    }
    return next();
  }
  const type = req.headers['content-type'] || '';
  if (!/^application\/json|^multipart\/form-data/i.test(type) && Number(req.headers['content-length'] || 0) > 0) {
    return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json'));
  }
  next();
}