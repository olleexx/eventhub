import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { queueEmail, kickEmailQueue } from './email.js';
import { audit } from './audit.js';

const ROLE_LABEL = { SCANNER: 'Ticket scanner', ATTENDEE_VIEWER: 'Attendee list viewer', MANAGER: 'Co-organizer (no finances)' };
const INVITE_TTL_MS = 7 * 86_400_000;

export async function inviteStaff({ user, access, email, role, ip }) {
  email = email.toLowerCase();
  if (email === user.email) throw badRequest('You already own this event');
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    const already = await prisma.eventStaff.findUnique({ where: { eventId_userId: { eventId: access.event.id, userId: existingUser.id } } });
    if (already) throw conflict('That person already has access to this event');
  }
  const raw = randomToken(32);
  const invite = await prisma.$transaction(async (tx) => {
    await tx.staffInvitation.deleteMany({ where: { eventId: access.event.id, email, acceptedAt: null } }); // one live invite per person
    const inv = await tx.staffInvitation.create({ data: { eventId: access.event.id, email, role, tokenHash: sha256(raw), invitedById: user.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
    await queueEmail(tx, { to: email, template: 'staff_invite', data: { inviterName: user.name, eventTitle: access.event.title, roleLabel: ROLE_LABEL[role], token: raw } });
    await audit({ actor: user, action: 'staff.invite', entityType: 'StaffInvitation', entityId: inv.id, eventId: access.event.id, after: { email, role }, ip }, tx);
    return inv;
  });
  kickEmailQueue();
  return invite;
}

export async function acceptInvitation({ user, token, ip }) {
  const inv = await prisma.staffInvitation.findUnique({ where: { tokenHash: sha256(token) }, include: { event: { select: { id: true, title: true } } } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw badRequest('This invitation is invalid or has expired', undefined, 'INVITE_INVALID');
  if (inv.email !== user.email) throw forbidden(`This invitation was sent to ${inv.email.replace(/^(.).*(@.*)$/, '$1***$2')}. Sign in with that address.`, 'INVITE_EMAIL_MISMATCH');
  if (!user.emailVerifiedAt) throw forbidden('Verify your email address first', 'EMAIL_NOT_VERIFIED');
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.staffInvitation.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (claimed.count === 0) throw badRequest('This invitation was already used');
    await tx.eventStaff.upsert({ where: { eventId_userId: { eventId: inv.eventId, userId: user.id } }, create: { eventId: inv.eventId, userId: user.id, role: inv.role }, update: { role: inv.role } });
    await audit({ actor: user, action: 'staff.accept', entityType: 'StaffInvitation', entityId: inv.id, eventId: inv.eventId, after: { role: inv.role }, ip }, tx);
  });
  return inv.event;
}

export async function listStaff(access) {
  const [staff, invites] = await Promise.all([
    prisma.eventStaff.findMany({ where: { eventId: access.event.id }, include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: 'asc' } }),
    prisma.staffInvitation.findMany({ where: { eventId: access.event.id, acceptedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, role: true, expiresAt: true } }),
  ]);
  return { staff: staff.map((s) => ({ id: s.id, userId: s.userId, name: s.user.name, email: s.user.email, role: s.role })), invites };
}

export async function removeStaff({ user, access, staffId, ip }) {
  const s = await prisma.eventStaff.findFirst({ where: { id: staffId, eventId: access.event.id } });
  if (!s) throw notFound('Staff member not found');
  await prisma.$transaction(async (tx) => {
    await tx.eventStaff.delete({ where: { id: staffId } });
    await audit({ actor: user, action: 'staff.remove', entityType: 'EventStaff', entityId: staffId, eventId: access.event.id, before: { userId: s.userId, role: s.role }, ip }, tx);
  });
}

export async function revokeInvite({ user, access, inviteId, ip }) {
  const r = await prisma.staffInvitation.deleteMany({ where: { id: inviteId, eventId: access.event.id, acceptedAt: null } });
  if (r.count) await audit({ actor: user, action: 'staff.invite_revoke', entityType: 'StaffInvitation', entityId: inviteId, eventId: access.event.id, ip });
}

export async function staffActivity(access, take = 100) {
  return prisma.auditLog.findMany({
    where: { eventId: access.event.id, action: { in: ['checkin.undo', 'staff.invite', 'staff.accept', 'staff.remove', 'event.update', 'ticket_type.price_change', 'ticket_type.inventory_change', 'event.publish', 'event.unpublish', 'refund.approve', 'refund.initiate'] } },
    orderBy: { createdAt: 'desc' }, take,
    select: { id: true, action: true, actorId: true, actorRole: true, before: true, after: true, createdAt: true },
  });
}
