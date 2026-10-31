import argon2 from 'argon2';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { badRequest, unauthorized, conflict, forbidden } from '../lib/errors.js';
import { queueEmail, kickEmailQueue } from './email.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';
import { revokeUserSessions } from '../middleware/session.js';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
// Pre-computed hash used to equalise timing when the email does not exist.
let dummyHash;
const getDummy = async () => (dummyHash ??= await argon2.hash('not-a-real-password', ARGON));

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export const hashPassword = (pw) => argon2.hash(pw, ARGON);
export const normalizeEmail = (e) => String(e).trim().toLowerCase();

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    emailVerified: Boolean(u.emailVerifiedAt),
    isOrganizer: Boolean(u.organizer),
    organizer: u.organizer ? { id: u.organizer.id, brandName: u.organizer.brandName, logoUrl: u.organizer.logoUrl, suspended: u.organizer.suspended } : null,
    marketingConsent: Boolean(u.marketingConsent),
    notifyPrefs: u.notifyPrefs,
  };
}

async function issueEmailToken(client, userId, type, ttlMs) {
  const raw = randomToken(32);
  await client.emailToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }); // invalidate older
  await client.emailToken.create({ data: { userId, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + ttlMs) } });
  return raw;
}

export async function register({ email, password, name, phone, asOrganizer, brandName, marketingConsent }, ip) {
  email = normalizeEmail(email);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
  const passwordHash = await hashPassword(password);
  const settings = await getSettings();

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email, passwordHash, name, phone: phone || null,
        role: asOrganizer ? 'ORGANIZER' : 'CUSTOMER',
        marketingConsent: Boolean(marketingConsent),
        consentAt: new Date(),
        ...(asOrganizer ? { organizer: { create: { brandName: brandName || name } } } : {}),
      },
      include: { organizer: true },
    });
    const token = await issueEmailToken(tx, u.id, 'VERIFY_EMAIL', 24 * 3600 * 1000);
    await queueEmail(tx, { to: email, template: 'verify_email', data: { name, token } });
    if (asOrganizer) {
      await queueEmail(tx, { to: email, template: 'organizer_welcome', data: { commissionText: `${settings.commissionPercent}%${Number(settings.commissionFixedPerTicket) > 0 ? ' + ' + settings.commissionFixedPerTicket + ' per ticket' : ''}` }, dedupeKey: `organizer-welcome:${u.id}` });
    }
    await audit({ actor: u, action: asOrganizer ? 'auth.register_organizer' : 'auth.register', entityType: 'User', entityId: u.id, ip }, tx);
    return u;
  });
  kickEmailQueue();
  return user;
}

export async function login({ email, password }, ip) {
  email = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { email }, include: { organizer: true } });
  if (!user) {
    await argon2.verify(await getDummy(), password).catch(() => {});
    throw unauthorized('Incorrect email or password', 'BAD_CREDENTIALS');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new (await import('../lib/errors.js')).AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }
  const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: failed >= MAX_FAILED ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : { failedLogins: failed },
    });
    throw unauthorized('Incorrect email or password', 'BAD_CREDENTIALS');
  }
  if (user.status !== 'ACTIVE') throw forbidden('This account has been suspended. Contact support.', 'ACCOUNT_SUSPENDED');
  if (user.failedLogins || user.lockedUntil) await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  if (argon2.needsRehash(user.passwordHash, ARGON)) {
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } }).catch(() => {});
  }
  await audit({ actor: user, action: 'auth.login', entityType: 'User', entityId: user.id, ip });
  return user;
}

export async function verifyEmail(rawToken) {
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!row || row.type !== 'VERIFY_EMAIL' || row.usedAt || row.expiresAt < new Date()) throw badRequest('This verification link is invalid or has expired', undefined, 'TOKEN_INVALID');
  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
  return row.userId;
}

export async function resendVerification(user) {
  if (user.emailVerifiedAt) return;
  const token = await prisma.$transaction(async (tx) => {
    const t = await issueEmailToken(tx, user.id, 'VERIFY_EMAIL', 24 * 3600 * 1000);
    await queueEmail(tx, { to: user.email, template: 'verify_email', data: { name: user.name, token: t } });
    return t;
  });
  kickEmailQueue();
  return token && true;
}

/** Always resolves (never reveals whether the email exists). */
export async function requestPasswordReset(email) {
  email = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== 'ACTIVE') return;
  await prisma.$transaction(async (tx) => {
    const token = await issueEmailToken(tx, user.id, 'RESET_PASSWORD', 3600 * 1000);
    await queueEmail(tx, { to: user.email, template: 'password_reset', data: { token } });
  });
  kickEmailQueue();
}

export async function resetPassword(rawToken, newPassword, ip) {
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(rawToken) }, include: { user: true } });
  if (!row || row.type !== 'RESET_PASSWORD' || row.usedAt || row.expiresAt < new Date()) throw badRequest('This reset link is invalid or has expired', undefined, 'TOKEN_INVALID');
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, failedLogins: 0, lockedUntil: null, emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() } });
    await queueEmail(tx, { to: row.user.email, template: 'security_change', data: { what: 'Your password was reset', when: new Date().toUTCString() } });
    await audit({ actor: row.user, action: 'auth.password_reset', entityType: 'User', entityId: row.userId, ip }, tx);
  });
  await revokeUserSessions(row.userId);
  kickEmailQueue();
}

export async function changePassword(user, currentPassword, newPassword, currentSessionId, ip) {
  const full = await prisma.user.findUnique({ where: { id: user.id } });
  if (!(await argon2.verify(full.passwordHash, currentPassword).catch(() => false))) throw unauthorized('Current password is incorrect', 'BAD_CREDENTIALS');
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await queueEmail(tx, { to: user.email, template: 'security_change', data: { what: 'Your password was changed', when: new Date().toUTCString() } });
    await audit({ actor: user, action: 'auth.password_change', entityType: 'User', entityId: user.id, ip }, tx);
  });
  await revokeUserSessions(user.id, currentSessionId);
  kickEmailQueue();
}

export async function updateProfile(user, { name, phone, notifyPrefs, marketingConsent }) {
  return prisma.user.update({
    where: { id: user.id },
    data: { ...(name !== undefined && { name }), ...(phone !== undefined && { phone: phone || null }), ...(notifyPrefs !== undefined && { notifyPrefs }), ...(marketingConsent !== undefined && { marketingConsent }) },
    include: { organizer: true },
  });
}

/** Turn an existing customer into an organizer (free; no approval step). */
export async function becomeOrganizer(user, { brandName }, ip) {
  if (user.organizer) return user.organizer;
  const settings = await getSettings();
  const profile = await prisma.$transaction(async (tx) => {
    const p = await tx.organizerProfile.create({ data: { userId: user.id, brandName } });
    if (user.role === 'CUSTOMER') await tx.user.update({ where: { id: user.id }, data: { role: 'ORGANIZER' } });
    await queueEmail(tx, { to: user.email, template: 'organizer_welcome', data: { commissionText: `${settings.commissionPercent}%${Number(settings.commissionFixedPerTicket) > 0 ? ' + ' + settings.commissionFixedPerTicket + ' per ticket' : ''}` }, dedupeKey: `organizer-welcome:${user.id}` });
    await audit({ actor: user, action: 'organizer.create', entityType: 'OrganizerProfile', entityId: p.id, ip }, tx);
    return p;
  });
  kickEmailQueue();
  return profile;
}

/** Idempotent initial admin provisioning (scripts/create-admin.js). Never exposed over HTTP. */
export async function provisionAdmin(email, password) {
  email = normalizeEmail(email);
  if (!password || password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const passwordHash = await hashPassword(password);
  return prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, name: 'Platform Admin', role: 'ADMIN', emailVerifiedAt: new Date() },
    update: { role: 'ADMIN', status: 'ACTIVE', passwordHash },
  });
}

export { config };
