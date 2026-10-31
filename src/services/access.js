// Object-level authorization for events. Every organizer/staff endpoint that takes an event id
// resolves it through here, so one organizer can never reach another organizer's data by editing
// an id in a URL. Callers without any access get 404 (existence is not revealed).
import { prisma } from '../lib/prisma.js';
import { notFound, forbidden } from '../lib/errors.js';

export function permissionsFor({ isOwner, staffRole }) {
  const manager = staffRole === 'MANAGER';
  return {
    view: isOwner || Boolean(staffRole),
    manage: isOwner || manager, // edit event + tickets (never finances)
    finance: isOwner, // revenue, commissions, payouts
    scan: isOwner || staffRole === 'SCANNER' || manager,
    attendees: isOwner || staffRole === 'ATTENDEE_VIEWER' || manager,
    staff: isOwner, // invite / remove staff
    publish: isOwner,
  };
}

export async function getEventAccess(user, eventId, { include } = {}) {
  if (!user) throw notFound('Event not found');
  const event = await prisma.event.findUnique({ where: { id: eventId }, include });
  if (!event) throw notFound('Event not found');
  const isOwner = Boolean(user.organizer && user.organizer.id === event.organizerId);
  let staffRole = null;
  if (!isOwner) {
    const staff = await prisma.eventStaff.findUnique({ where: { eventId_userId: { eventId, userId: user.id } } });
    staffRole = staff?.role ?? null;
  }
  if (!isOwner && !staffRole) throw notFound('Event not found');
  return { event, isOwner, staffRole, can: permissionsFor({ isOwner, staffRole }) };
}

export function assertCan(access, permission) {
  if (!access.can[permission]) throw forbidden('Your role does not allow this action');
  return access;
}

export async function requireEvent(user, eventId, permission, opts) {
  const access = await getEventAccess(user, eventId, opts);
  return assertCan(access, permission);
}

/** Events a user may open in the organizer area (owned + staffed). */
export async function listAccessibleEventIds(user) {
  const owned = user.organizer ? await prisma.event.findMany({ where: { organizerId: user.organizer.id }, select: { id: true } }) : [];
  const staffed = await prisma.eventStaff.findMany({ where: { userId: user.id }, select: { eventId: true } });
  return { owned: owned.map((e) => e.id), staffed: staffed.map((s) => s.eventId) };
}
