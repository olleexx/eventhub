import { Router } from 'express';
import { asyncHandler } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';
import { createSession, destroySession } from '../middleware/session.js';
import * as auth from '../services/auth.js';
import * as v from '../validators/auth.js';
import { prisma } from '../lib/prisma.js';
import { getSettings, publicSettings } from '../services/settings.js';

const router = Router();

const me = (req) => ({ user: auth.publicUser(req.user), csrfToken: req.session?.csrfToken ?? null });

// Bootstrap call for the SPA: user (or null), CSRF token, public settings, active announcements.
router.get('/me', asyncHandler(async (req, res) => {
  const [settings, announcements] = await Promise.all([
    getSettings(),
    prisma.announcement.findMany({ where: { active: true, OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }] }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, title: true, body: true } }),
  ]);
  res.json({ ok: true, data: { ...me(req), settings: publicSettings(settings), announcements } });
}));

router.post('/register', authLimiter, validate({ body: v.registerBody }), asyncHandler(async (req, res) => {
  const user = await auth.register(req.body, req.ip);
  const csrfToken = await createSession(req, res, user.id);
  res.status(201).json({ ok: true, data: { user: auth.publicUser(user), csrfToken } });
}));

router.post('/login', authLimiter, validate({ body: v.loginBody }), asyncHandler(async (req, res) => {
  const user = await auth.login(req.body, req.ip);
  if (req.session) await destroySession(req, res); // rotate: never reuse a pre-login session
  const csrfToken = await createSession(req, res, user.id);
  res.json({ ok: true, data: { user: auth.publicUser(user), csrfToken } });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true, data: {} });
}));

router.post('/verify-email', authLimiter, validate({ body: v.tokenBody }), asyncHandler(async (req, res) => {
  await auth.verifyEmail(req.body.token);
  res.json({ ok: true, data: { verified: true } });
}));

router.post('/resend-verification', requireAuth, authLimiter, asyncHandler(async (req, res) => {
  await auth.resendVerification(req.user);
  res.json({ ok: true, data: {} });
}));

router.post('/forgot-password', authLimiter, validate({ body: v.forgotBody }), asyncHandler(async (req, res) => {
  await auth.requestPasswordReset(req.body.email);
  res.json({ ok: true, data: { message: 'If that email has an account, a reset link is on its way.' } });
}));

router.post('/reset-password', authLimiter, validate({ body: v.resetBody }), asyncHandler(async (req, res) => {
  await auth.resetPassword(req.body.token, req.body.password, req.ip);
  res.json({ ok: true, data: {} });
}));

router.post('/change-password', requireAuth, authLimiter, validate({ body: v.changePasswordBody }), asyncHandler(async (req, res) => {
  await auth.changePassword(req.user, req.body.currentPassword, req.body.newPassword, req.session.id, req.ip);
  res.json({ ok: true, data: {} });
}));

router.patch('/profile', requireAuth, validate({ body: v.profileBody }), asyncHandler(async (req, res) => {
  const user = await auth.updateProfile(req.user, req.body);
  res.json({ ok: true, data: { user: auth.publicUser(user) } });
}));

router.post('/become-organizer', requireAuth, validate({ body: v.becomeOrganizerBody }), asyncHandler(async (req, res) => {
  await auth.becomeOrganizer(req.user, req.body, req.ip);
  const fresh = await prisma.user.findUnique({ where: { id: req.user.id }, include: { organizer: true } });
  res.status(201).json({ ok: true, data: { user: auth.publicUser(fresh) } });
}));

export default router;
