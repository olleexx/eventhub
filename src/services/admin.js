// Platform administration. Every mutating function writes an audit record with the acting admin.
import { prisma, Prisma } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { toMinor, fromMinor } from '../lib/money.js';
import { slugify } from './categories.js';
import { audit } from './audit.js';
import { revokeUserSessions } from '../middleware/session.js';
import { queueEmail, kickEmailQueue } from './email.js';
import { organizerBalance } from './ledger.js';
import { decrypt } from '../lib/secretbox.js';
import { reconcilePayment } from './reconcile.js';

const dec = (d) => (d == null ? null : d.toString());

// ---------------------------------------------------------------- users / organizers
export async function listUsers({ q, role, status, page, pageSize }) {
  const where = { ...(role ? { role } : {}), ...(status ? { status } : {}), ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}) };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true, email: true, name: true, role: true, status: true, emailVerifiedAt: true, createdAt: true, organizer: { select: { id: true, brandName: true, suspended: true } }, _count: { select: { orders: true } } } }),
  ]);
  return { total, items: rows };
}

export async function getUserDetail(id) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, phone: true, role: true, status: true, emailVerifiedAt: true, failedLogins: true, lockedUntil: true, createdAt: true, organizer: true, orders: { take: 10, orderBy: { createdAt: 'desc' }, select: { reference: true, total: true, status: true, createdAt: true } }, _count: { select: { sessions: true, reportsMade: true } } } });
  if (!u) throw notFound('User not found');
  const audits = await prisma.auditLog.findMany({ where: { OR: [{ actorId: id }, { entityType: 'User', entityId: id }] }, orderBy: { createdAt: 'desc' }, take: 30 });
  const balance = u.organizer ? (await organizerBalance(u.organizer.id)).formatted : null;
  const { payoutAccountEnc, ...org } = u.organizer ?? {};
  return { ...u, organizer: u.organizer ? { ...org, payoutAccountSet: Boolean(payoutAccountEnc) } : null, balance, audits };
}

export async function setUserStatus(admin, id, status, reason, ip) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('User not found');
  if (u.id === admin.id) throw forbidden('You cannot change your own status');
  if (u.role === 'ADMIN') throw forbidden('Administrators cannot be suspended here');
  await prisma.user.update({ where: { id }, data: { status } });
  if (status === 'SUSPENDED') await revokeUserSessions(id);
  await audit({ actor: admin, action: status === 'SUSPENDED' ? 'user.suspend' : 'user.reactivate', entityType: 'User', entityId: id, before: { status: u.status }, after: { status, reason }, ip });
}

export async function setOrganizerSuspended(admin, organizerId, suspended, reason, ip) {
  const o = await prisma.organizerProfile.findUnique({ where: { id: organizerId } });
  if (!o) throw notFound('Organizer not found');
  await prisma.organizerProfile.update({ where: { id: organizerId }, data: { suspended } });
  await audit({ actor: admin, action: suspended ? 'organizer.suspend' : 'organizer.restore', entityType: 'OrganizerProfile', entityId: organizerId, after: { suspended, reason }, ip });
}

// ---------------------------------------------------------------- events / moderation
export async function listAdminEvents({ q, status, page, pageSize }) {
  const where = { ...(status ? { status } : {}), ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { organizer: { brandName: { contains: q, mode: 'insensitive' } } }] } : {}) };
  const [total, rows] = await Promise.all([
    prisma.event.count({ where }),
    prisma.event.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true, title: true, slug: true, status: true, featured: true, startsAt: true, ticketsSold: true, moderationNote: true, commissionOverridePercent: true, commissionOverrideFixed: true, organizer: { select: { id: true, brandName: true } }, _count: { select: { reports: { where: { status: 'OPEN' } } } } } }),
  ]);
  return { total, items: rows.map((e) => ({ ...e, commissionOverridePercent: dec(e.commissionOverridePercent), commissionOverrideFixed: dec(e.commissionOverrideFixed) })) };
}

export async function moderateEvent(admin, eventId, { action, note }, ip) {
  const e = await prisma.event.findUnique({ where: { id: eventId } });
  if (!e) throw notFound('Event not found');
  let data;
  switch (action) {
    case 'suspend': data = { status: 'SUSPENDED', moderationNote: note }; break;
    case 'unpublish': data = { status: 'UNPUBLISHED', moderationNote: note }; break;
    case 'restore': if (!['SUSPENDED', 'UNPUBLISHED'].includes(e.status)) throw conflict('Only suspended/unpublished events can be restored'); data = { status: 'PUBLISHED', publishedAt: e.publishedAt ?? new Date(), moderationNote: null }; break;
    case 'feature': data = { featured: true }; break;
    case 'unfeature': data = { featured: false }; break;
    default: throw badRequest('Unknown action');
  }
  const updated = await prisma.event.update({ where: { id: eventId }, data });
  const org = await prisma.organizerProfile.findUnique({ where: { id: e.organizerId }, include: { user: true } });
  if (['suspend', 'unpublish'].includes(action) && org) {
    await queueEmail(prisma, { to: org.user.email, template: 'event_update', data: { eventTitle: e.title, eventSlug: e.slug, message: `Your event was ${action === 'suspend' ? 'suspended' : 'unpublished'} by the platform team. Reason: ${note}. You can appeal from your dashboard.` }, dedupeKey: `moderation:${eventId}:${action}:${Date.now()}` });
    kickEmailQueue();
  }
  await audit({ actor: admin, action: `event.moderate.${action}`, entityType: 'Event', entityId: eventId, eventId, before: { status: e.status, featured: e.featured }, after: { status: updated.status, featured: updated.featured, note }, ip });
  return updated;
}

export async function setEventCommission(admin, eventId, { percent, fixed }, ip) {
  const e = await prisma.event.findUnique({ where: { id: eventId } });
  if (!e) throw notFound('Event not found');
  const u = await prisma.event.update({ where: { id: eventId }, data: { commissionOverridePercent: percent ?? null, commissionOverrideFixed: fixed ?? null } });
  await audit({ actor: admin, action: 'event.commission_override', entityType: 'Event', entityId: eventId, eventId, before: { percent: dec(e.commissionOverridePercent), fixed: dec(e.commissionOverrideFixed) }, after: { percent: dec(u.commissionOverridePercent), fixed: dec(u.commissionOverrideFixed) }, ip });
  return u;
}

export async function eventHistory(eventId) {
  return prisma.auditLog.findMany({ where: { eventId }, orderBy: { createdAt: 'desc' }, take: 200 });
}

// ---------------------------------------------------------------- reports, appeals, support
export async function listReports({ status, page, pageSize }) {
  const where = status ? { status } : {};
  const [total, items] = await Promise.all([prisma.eventReport.count({ where }), prisma.eventReport.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { event: { select: { id: true, title: true, slug: true, status: true } }, reporter: { select: { email: true } } } })]);
  return { total, items };
}

export async function resolveReport(admin, id, { status, resolution }, ip) {
  const r = await prisma.eventReport.findUnique({ where: { id } });
  if (!r) throw notFound('Report not found');
  const u = await prisma.eventReport.update({ where: { id }, data: { status, resolution, resolvedById: admin.id } });
  await audit({ actor: admin, action: 'report.resolve', entityType: 'EventReport', entityId: id, eventId: r.eventId, after: { status, resolution }, ip });
  return u;
}

export async function createAppeal(user, access, message) {
  if (!['SUSPENDED', 'UNPUBLISHED', 'CANCELLED'].includes(access.event.status) || !access.event.moderationNote) throw conflict('Only events moderated by the platform can be appealed');
  const open = await prisma.moderationAppeal.count({ where: { eventId: access.event.id, status: { in: ['OPEN', 'REVIEWING'] } } });
  if (open) throw conflict('An appeal is already open for this event');
  return prisma.moderationAppeal.create({ data: { eventId: access.event.id, userId: user.id, message } });
}

export async function listAppeals({ status, page, pageSize }) {
  const where = status ? { status } : {};
  const [total, items] = await Promise.all([prisma.moderationAppeal.count({ where }), prisma.moderationAppeal.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { event: { select: { id: true, title: true, status: true, moderationNote: true } } } })]);
  return { total, items };
}

export async function decideAppeal(admin, id, { decision, response }, ip) {
  const a = await prisma.moderationAppeal.findUnique({ where: { id }, include: { event: true } });
  if (!a) throw notFound('Appeal not found');
  if (['ACTIONED', 'DISMISSED'].includes(a.status)) throw conflict('Appeal already decided');
  await prisma.$transaction(async (tx) => {
    await tx.moderationAppeal.update({ where: { id }, data: { status: decision === 'uphold' ? 'ACTIONED' : 'DISMISSED', response, decidedById: admin.id } });
    if (decision === 'uphold' && a.event.status === 'SUSPENDED') await tx.event.update({ where: { id: a.eventId }, data: { status: 'UNPUBLISHED', moderationNote: null } });
    await audit({ actor: admin, action: `appeal.${decision}`, entityType: 'ModerationAppeal', entityId: id, eventId: a.eventId, after: { response } }, tx);
  });
}

export async function createSupportRequest({ user, email, subject, message }) {
  return prisma.supportRequest.create({ data: { userId: user?.id ?? null, email: (user?.email ?? email).toLowerCase(), subject, message } });
}

export async function listSupport({ status, page, pageSize }) {
  const where = status ? { status } : {};
  const [total, items] = await Promise.all([prisma.supportRequest.count({ where }), prisma.supportRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize })]);
  return { total, items };
}

export async function replySupport(admin, id, reply, ip) {
  const r = await prisma.supportRequest.findUnique({ where: { id } });
  if (!r) throw notFound('Request not found');
  await prisma.supportRequest.update({ where: { id }, data: { reply, status: 'ACTIONED' } });
  await queueEmail(prisma, { to: r.email, template: 'support_reply', data: { subject: r.subject, reply }, dedupeKey: `support-reply:${id}:${Date.now()}` });
  kickEmailQueue();
  await audit({ actor: admin, action: 'support.reply', entityType: 'SupportRequest', entityId: id, ip });
}

// ---------------------------------------------------------------- orders / payments investigation
export async function adminOrders({ q, status, eventId, page, pageSize }) {
  const where = { ...(status ? { status } : {}), ...(eventId ? { eventId } : {}), ...(q ? { OR: [{ reference: { contains: q, mode: 'insensitive' } }, { buyerEmail: { contains: q, mode: 'insensitive' } }] } : {}) };
  const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { event: { select: { title: true } }, payments: { select: { status: true, lastGatewayStatus: true }, take: 1, orderBy: { createdAt: 'desc' } } } })]);
  return { total, items: rows.map((o) => ({ reference: o.reference, event: o.event.title, buyerEmail: o.buyerEmail, status: o.status, total: dec(o.total), commission: dec(o.commissionTotal), refunded: dec(o.refundedTotal), payment: o.payments[0]?.status ?? null, gatewayStatus: o.payments[0]?.lastGatewayStatus ?? null, reviewNote: o.reviewNote, createdAt: o.createdAt })) };
}

export async function adminOrderDetail(reference) {
  const o = await prisma.order.findUnique({ where: { reference }, include: { event: { select: { id: true, title: true, organizerId: true } }, items: true, tickets: { select: { number: true, status: true, checkedInAt: true } }, payments: true, refunds: true, commissions: true, ledger: { orderBy: { createdAt: 'asc' } } } });
  if (!o) throw notFound('Order not found');
  const hooks = await prisma.paymentWebhookEvent.findMany({ where: { OR: o.payments.filter((p) => p.gatewayCheckoutId).map((p) => ({ payload: { path: ['data', 'id'], equals: p.gatewayCheckoutId } })).concat([{ payload: { path: ['data', 'metadata', 'order_reference'], equals: reference } }]) }, orderBy: { receivedAt: 'desc' }, take: 20, select: { id: true, eventId: true, type: true, status: true, attempts: true, error: true, receivedAt: true, processedAt: true } });
  return { ...o, webhookEvents: hooks };
}

/** Admin resolution of NEEDS_REVIEW / stuck orders. */
export async function resolveOrder(admin, reference, action, ip) {
  const o = await prisma.order.findUnique({ where: { reference }, include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } } });
  if (!o) throw notFound('Order not found');
  let out;
  if (action === 'recheck') {
    if (!o.payments[0]) throw badRequest('No payment attempt on this order');
    out = await reconcilePayment(o.payments[0].id, `admin:${admin.id}`);
  } else if (action === 'refund_full') {
    if (!['NEEDS_REVIEW'].includes(o.status)) throw conflict('Only orders needing review can be refunded this way');
    await prisma.refund.createMany({ data: [{ orderId: o.id, amount: o.total, reason: 'Admin: refund of order needing review', status: 'APPROVED', reviewedById: admin.id, idempotencyKey: `review:${o.id}` }], skipDuplicates: true });
    out = 'refund_queued';
  } else throw badRequest('Unknown action');
  await audit({ actor: admin, action: `order.resolve.${action}`, entityType: 'Order', entityId: o.id, eventId: o.eventId, after: { out }, ip });
  return out;
}

// ---------------------------------------------------------------- financial reports
export async function commissionReport({ from, to }) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT op."id" AS "organizerId", op."brandName", e."id" AS "eventId", e."title",
           COUNT(o."id")::int AS orders, COALESCE(SUM(o."total"),0)::text AS gross,
           COALESCE(SUM(cr."amount"),0)::text AS commission, COALESCE(SUM(cr."reversedAmount"),0)::text AS reversed,
           COALESCE(SUM(o."refundedTotal"),0)::text AS refunded, COALESCE(SUM(o."gatewayFee"),0)::text AS fees
      FROM "Order" o JOIN "Event" e ON e."id" = o."eventId" JOIN "OrganizerProfile" op ON op."id" = e."organizerId" LEFT JOIN "CommissionRecord" cr ON cr."orderId" = o."id"
     WHERE o."status" IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND o."paidAt" >= ${from} AND o."paidAt" <= ${to}
     GROUP BY op."id", op."brandName", e."id", e."title" ORDER BY SUM(o."total") DESC LIMIT 1000`);
  return rows.map((r) => ({ ...r, commissionNet: fromMinor(toMinor(r.commission) - toMinor(r.reversed)), organizerNet: fromMinor(toMinor(r.gross) - toMinor(r.refunded) - (toMinor(r.commission) - toMinor(r.reversed))) }));
}

export async function ledgerExport({ from, to }) {
  return prisma.organizerLedgerEntry.findMany({ where: { createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'asc' }, take: 50_000, include: { organizer: { select: { brandName: true } }, order: { select: { reference: true } } } });
}

export async function organizerPayoutDetails(organizerId, admin, ip) {
  const o = await prisma.organizerProfile.findUnique({ where: { id: organizerId } });
  if (!o) throw notFound('Organizer not found');
  await audit({ actor: admin, action: 'organizer.view_payout_details', entityType: 'OrganizerProfile', entityId: organizerId, ip });
  return { bankName: o.payoutBankName, accountName: o.payoutAccountName, accountNumber: o.payoutAccountEnc ? decrypt(o.payoutAccountEnc) : null };
}

export async function listOrganizersWithBalances({ page, pageSize, q }) {
  const where = q ? { brandName: { contains: q, mode: 'insensitive' } } : {};
  const [total, rows] = await Promise.all([prisma.organizerProfile.count({ where }), prisma.organizerProfile.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { user: { select: { email: true, status: true } } } })]);
  const items = [];
  for (const o of rows) items.push({ id: o.id, brandName: o.brandName, email: o.user.email, userStatus: o.user.status, suspended: o.suspended, payoutDetailsSet: Boolean(o.payoutAccountEnc), balance: (await organizerBalance(o.id)).formatted });
  return { total, items };
}

export async function listAudit({ action, entityType, actorId, eventId, page, pageSize }) {
  const where = { ...(action ? { action: { contains: action } } : {}), ...(entityType ? { entityType } : {}), ...(actorId ? { actorId } : {}), ...(eventId ? { eventId } : {}) };
  const [total, items] = await Promise.all([prisma.auditLog.count({ where }), prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize })]);
  return { total, items };
}

// ---------------------------------------------------------------- announcements
export const listAnnouncements = () => prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
export async function saveAnnouncement(admin, id, data, ip) {
  const row = id ? await prisma.announcement.update({ where: { id }, data }) : await prisma.announcement.create({ data });
  await audit({ actor: admin, action: id ? 'announcement.update' : 'announcement.create', entityType: 'Announcement', entityId: row.id, after: { title: data.title, active: data.active }, ip });
  return row;
}

export { slugify };
