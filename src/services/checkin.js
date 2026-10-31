// Ticket check-in. The QR content is only a lookup key; every scan is decided by the database.
//
// Atomicity: admission is ONE conditional UPDATE
//     UPDATE "Ticket" SET status='USED', "checkedInAt"=now() WHERE id=? AND status='VALID'
// Exactly one concurrent scanner can get rowCount = 1. Everyone else sees ALREADY_USED.
// Retries: the client sends a scanId per attempt; if the network drops after the server admitted
// the ticket, re-sending the SAME scanId returns ADMITTED again instead of a confusing "already used".
import { prisma } from '../lib/prisma.js';
import { parseTicketInput } from './tickets.js';
import { requireEvent } from './access.js';
import { audit } from './audit.js';

const fmt = (t) => ({ number: t.number, type: t.ticketType?.name, holderName: t.holderName, checkedInAt: t.checkedInAt });

export async function scanTicket({ user, eventId, input, scanId, method = 'QR' }) {
  const access = await requireEvent(user, eventId, 'scan'); // owner / manager / scanner only
  const { event } = access;
  const { code, number } = parseTicketInput(input);
  if (!code && !number) return { result: 'INVALID', message: 'Not a valid ticket code' };

  const ticket = await prisma.ticket.findUnique({ where: code ? { code } : { number }, include: { ticketType: { select: { name: true } }, checkIn: true } });
  if (!ticket) return { result: 'INVALID', message: 'Ticket not found' };
  if (ticket.eventId !== eventId) return { result: 'WRONG_EVENT', message: 'This ticket is for a different event' };
  if (event.status === 'CANCELLED' || event.status === 'SUSPENDED') return { result: 'EVENT_CANCELLED', message: `Event is ${event.status.toLowerCase()}`, ticket: fmt(ticket) };
  if (ticket.status === 'REFUNDED') return { result: 'REFUNDED', message: 'Ticket was refunded', ticket: fmt(ticket) };
  if (ticket.status === 'CANCELLED') return { result: 'CANCELLED', message: 'Ticket was cancelled', ticket: fmt(ticket) };

  const admitted = await prisma.ticket.updateMany({ where: { id: ticket.id, status: 'VALID' }, data: { status: 'USED', checkedInAt: new Date() } });
  if (admitted.count === 1) {
    const fresh = await prisma.ticket.findUnique({ where: { id: ticket.id }, include: { ticketType: { select: { name: true } } } });
    await prisma.checkIn.createMany({ data: [{ ticketId: ticket.id, eventId, scannedById: user.id, method, clientScanId: scanId ?? null, scannedAt: fresh.checkedInAt }], skipDuplicates: true });
    return { result: 'ADMITTED', message: 'Welcome in!', ticket: fmt(fresh) };
  }

  // Lost the race or already used. Idempotent replay of our own successful scan:
  const current = await prisma.ticket.findUnique({ where: { id: ticket.id }, include: { ticketType: { select: { name: true } }, checkIn: true } });
  if (scanId && current.checkIn?.clientScanId === scanId) return { result: 'ADMITTED', message: 'Welcome in!', replay: true, ticket: fmt(current) };
  if (current.status === 'USED') return { result: 'ALREADY_USED', message: `Already scanned at ${current.checkedInAt?.toISOString()}`, ticket: fmt(current) };
  return { result: current.status === 'REFUNDED' ? 'REFUNDED' : 'CANCELLED', message: `Ticket is ${current.status.toLowerCase()}`, ticket: fmt(current) };
}

export async function checkinStats(user, eventId) {
  await requireEvent(user, eventId, 'scan');
  const [byStatus, byType, recent] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], where: { eventId }, _count: true }),
    prisma.ticket.groupBy({ by: ['ticketTypeId', 'status'], where: { eventId, status: { in: ['VALID', 'USED'] } }, _count: true }),
    prisma.checkIn.findMany({ where: { eventId }, orderBy: { scannedAt: 'desc' }, take: 10, include: { ticket: { select: { number: true, holderName: true, ticketType: { select: { name: true } } } } } }),
  ]);
  const count = (s) => byStatus.find((x) => x.status === s)?._count ?? 0;
  const types = await prisma.ticketType.findMany({ where: { eventId }, select: { id: true, name: true } });
  return {
    admitted: count('USED'), remainingValid: count('VALID'), refunded: count('REFUNDED'), cancelled: count('CANCELLED'),
    total: count('USED') + count('VALID'),
    byType: types.map((t) => ({ name: t.name, admitted: byType.find((b) => b.ticketTypeId === t.id && b.status === 'USED')?._count ?? 0, valid: byType.find((b) => b.ticketTypeId === t.id && b.status === 'VALID')?._count ?? 0 })).filter((t) => t.admitted + t.valid > 0),
    recent: recent.map((c) => ({ number: c.ticket.number, holderName: c.ticket.holderName, type: c.ticket.ticketType.name, at: c.scannedAt })),
  };
}

/** Manual override by owner/manager only (e.g. undo an accidental scan). Audited. */
export async function undoCheckIn({ user, eventId, ticketId, ip }) {
  const access = await requireEvent(user, eventId, 'manage');
  const t = await prisma.ticket.findFirst({ where: { id: ticketId, eventId, status: 'USED' } });
  if (!t) return false;
  await prisma.$transaction(async (tx) => {
    await tx.ticket.update({ where: { id: ticketId }, data: { status: 'VALID', checkedInAt: null } });
    await tx.checkIn.deleteMany({ where: { ticketId } });
    await audit({ actor: user, action: 'checkin.undo', entityType: 'Ticket', entityId: ticketId, eventId: access.event.id, ip }, tx);
  });
  return true;
}
