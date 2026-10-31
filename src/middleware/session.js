// Server-side sessions stored in the Session table (token hash only; the raw token lives in an
// HTTP-only cookie). Includes the per-session CSRF token used by middleware/csrf.js.
import { prisma } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { randomToken, sha256 } from '../utils/crypto.js';

export const COOKIE_NAME = config.isProd ? '__Host-eh.sid' : 'eh.sid';
const TTL_MS = config.SESSION_TTL_HOURS * 3600 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.isProd,
  sameSite: 'lax',
  path: '/',
  maxAge: TTL_MS,
});

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Attaches req.session ({id, csrfToken, userId}) and req.user (or null). Never throws on bad cookies. */
export async function sessionMiddleware(req, res, next) {
  req.user = null;
  req.session = null;
  try {
    const raw = readCookie(req, COOKIE_NAME);
    if (raw && raw.length >= 32 && raw.length <= 128) {
      const row = await prisma.session.findUnique({
        where: { tokenHash: sha256(raw) },
        include: { user: { include: { organizer: true } } },
      });
      if (row && row.expiresAt > new Date() && row.user.status === 'ACTIVE') {
        req.session = { id: row.id, csrfToken: row.csrfToken, userId: row.userId };
        req.user = row.user;
        if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
          prisma.session
            .update({ where: { id: row.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + TTL_MS) } })
            .catch(() => {});
          res.cookie(COOKIE_NAME, raw, cookieOptions());
        }
      } else if (row) {
        // expired or suspended user: clean up
        prisma.session.delete({ where: { id: row.id } }).catch(() => {});
      }
    }
  } catch (err) {
    return next(err);
  }
  next();
}

/** Create a fresh session (call after successful login: prevents session fixation). */
export async function createSession(req, res, userId) {
  const raw = randomToken(32);
  const csrfToken = randomToken(24);
  await prisma.session.create({
    data: {
      tokenHash: sha256(raw),
      csrfToken,
      userId,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
  res.cookie(COOKIE_NAME, raw, cookieOptions());
  return csrfToken;
}

export async function destroySession(req, res) {
  if (req.session) await prisma.session.delete({ where: { id: req.session.id } }).catch(() => {});
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

/** Revoke every session of a user (password reset/change, suspension). Optionally keep one. */
export async function revokeUserSessions(userId, exceptSessionId) {
  await prisma.session.deleteMany({ where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) } });
}

export async function purgeExpiredSessions() {
  const r = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return r.count;
}
