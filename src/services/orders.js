// Order/attendee queries for organizers (scoped by event access), customers (own orders) and exports.
import { prisma } from '../lib/prisma.js';
import { toMinor, fromMinor } from '../lib/money.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { getEventAccess, listAccessibleEventIds } from './access.js';
import { resendTicketEmail } from './fulfilment.js';
import { notFound, forbidden } from '../lib/errors.js';

const dec = (d) => (d == null ? null : d.toString());

/** Organizer sales list. Finance columns (commission, net, fees) only for owners. */
export async function organizerOrders({ user, eventId, status, q, from, to, sort = 'new', page, pageSize }) {
  let eventFilter;
  let finance = false;
  if (eventId) {
    const access = await getEventAccess(user, eventId);
    if (!access.can.finance) throw forbidden('Only the event owner can view sales and revenue');
    eventFilter = { eventId };
    finance = true;
  } else {
    if (!user.organizer) throw forbidden('Organizer account required');
    eventFilter = { event: { organizerId: user.organizer.id } };
    finance = true;
  }
  const where = {
    ...eventFilter,
    ...(status ? { status } : { status: { not: 'EXPIRED' } }),
    ...(q ? { OR: [{ reference: { contains: q, mode: 'insensitive' } }, { buyerEmail: { contains: q, mode: 'insensitive' } }, { buyerName: { contains: q, mode: 'insensitive' } }] } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
  const orderBy = { new: { createdAt: 'desc' }, old: { createdAt: 'asc' }, total_desc: { total: 'desc' }, total_asc: { total: 'asc' } }[sort] ?? { createdAt: 'desc' };
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, include: { event: { select: { id: true, title: true } }, items: { select: { quantity: true, ticketType: { select: { name: true } } } }, refunds: { select: { status: true, amount: true } } } }),
  ]);
  return {
    total,
    items: rows.map((o) => ({
      reference: o.reference, id: o.id, eventId: o.event.id, eventTitle: o.event.title, customerName: o.buyerName, customerEmail: o.buyerEmail,
      tickets: o.items.map((i) => `${i.quantity} x ${i.ticketType.name}`).join(', '), quantity: o.items.reduce((a, i) => a + i.quantity, 0),
      total: dec(o.total), currency: o.currency, status: o.status, paymentStatus: o.status === 'PENDING' ? 'AWAITING_PAYMENT' : ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(o.status) ? 'PAID' : o.status,
      ...(finance ? { commission: dec(o.commissionTotal), gatewayFee: dec(o.gatewayFee), organizerNet: fromMinor(toMinor(o.total) - toMinor(o.commissionTotal) - toMinor(o.refundedTotal) + 0) } : {}),
      refundedTotal: dec(o.refundedTotal), refundStatus: o.refunds[0]?.status ?? null, purchasedAt: o.paidAt ?? o.createdAt, createdAt: o.createdAt,
    })),
  };
}

export async function organizerOrderDetail(user, reference) {
  const order = await prisma.order.findUnique({ where: { reference }, include: { event: true, items: { include: { ticketType: { select: { name: true } } } }, tickets: { include: { ticketType: { select: { name: true } } } }, refunds: true, payments: { select: { status: true, amount: true, gatewayFee: true, lastGatewayStatus: true, verifiedAt: true, createdAt: true } } } });
  if (!order) throw notFound('Order not found');
  const access = await getEventAccess(user, order.eventId).catch(() => null);
  if (!access?.can.finance) throw notFound('Order not found');
  return order;
}

export async function listAttendees({ user, eventId, q, ticketTypeId, checkedIn, page, pageSize, all = false }) {
  const access = await getEventAccess(user, eventId);
  if (!access.can.attendees) throw forbidden('Your role cannot view attendees');
  const where = {
    eventId,
    status: { in: ['VALID', 'USED'] },
    ...(ticketTypeId ? { ticketTypeId } : {}),
    ...(checkedIn === 'yes' ? { status: 'USED' } : checkedIn === 'no' ? { status: 'VALID' } : {}),
    ...(q ? { OR: [{ holderName: { contains: q, mode: 'insensitive' } }, { holderEmail: { contains: q, mode: 'insensitive' } }, { number: { contains: q.toUpperCase() } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.ticket.findMany({ where, orderBy: [{ holderName: 'asc' }, { createdAt: 'asc' }], ...(all ? { take: 20000 } : { skip: (page - 1) * pageSize, take: pageSize }), include: { ticketType: { select: { name: true } }, order: { select: { reference: true, buyerPhone: true } } } }),
  ]);
  return {
    total, access: access.can,
    items: rows.map((t) => ({ id: t.id, number: t.number, name: t.holderName, email: t.holderEmail, phone: t.order.buyerPhone, ticketType: t.ticketType.name, orderReference: t.order.reference, status: t.status, checkedInAt: t.checkedInAt, answers: t.answers })),
  };
}

export async function resendForOrganizer(user, reference) {
  const order = await prisma.order.findUnique({ where: { reference }, select: { id: true, eventId: true } });
  if (!order) throw notFound('Order not found');
  const access = await getEventAccess(user, order.eventId).catch(() => null);
  if (!access?.can.attendees) throw notFound('Order not found');
  return resendTicketEmail(order.id);
}

/** Customer: their own orders (account is the authority; guests use the emailed link). */
export async function customerOrders(user) {
  return prisma.order.findMany({
    where: { OR: [{ userId: user.id }, { userId: null, buyerEmail: user.email, ...(user.emailVerifiedAt ? {} : { id: '__none__' }) }], status: { not: 'EXPIRED' } },
    orderBy: { createdAt: 'desc' }, take: 100,
    select: { reference: true, status: true, total: true, currency: true, createdAt: true, paidAt: true, refundedTotal: true, event: { select: { title: true, slug: true, startsAt: true, bannerUrl: true } }, _count: { select: { tickets: true } } },
  });
}

/**
 * Guest ticket retrieval by email. Always answers the same way (no account/order enumeration); if the
 * address has paid orders, the ticket emails are re-queued TO THAT ADDRESS only (proof of mailbox access).
 */
export async function requestTicketResend(email) {
  const orders = await prisma.order.findMany({ where: { buyerEmail: email.toLowerCase(), status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, event: { endsAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true } });
  for (const o of orders) await resendTicketEmail(o.id);
  return orders.length;
}

export { listAccessibleEventIds, randomToken, sha256 };
