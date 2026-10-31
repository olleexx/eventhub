import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, forbidden } from '../lib/errors.js';
import { ok, page } from '../lib/http.js';
import { toCsv, sendCsv } from '../utils/csv.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireOrganizer } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/security.js';
import { saveImage, MAX_UPLOAD_BYTES } from '../lib/storage.js';
import { requireEvent, getEventAccess, listAccessibleEventIds } from '../services/access.js';
import { encrypt } from '../lib/secretbox.js';
import * as events from '../services/events.js';
import * as analytics from '../services/analytics.js';
import * as orders from '../services/orders.js';
import * as staff from '../services/staff.js';
import * as refunds from '../services/refunds.js';
import * as settlements from '../services/settlements.js';
import * as admin from '../services/admin.js';
import { organizerBalance } from '../services/ledger.js';
import { audit } from '../services/audit.js';
import * as v from '../validators/events.js';
import * as a from '../validators/admin.js';
import { id, pageQuery } from '../validators/common.js';

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }, fileFilter: (req, file, cb) => (/^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(badRequest('Only JPEG, PNG or WebP images are allowed', undefined, 'INVALID_IMAGE'))) });
const ev = z.object({ eventId: id });
const fromTo = (q) => ({ preset: q.preset === 'custom' ? undefined : q.preset, from: q.from, to: q.to });

// ------------------------------------------------------------------ dashboard (organizer-only)
router.get('/overview', requireOrganizer, validate({ query: a.rangeQuery }), asyncHandler(async (req, res) => ok(res, await analytics.organizerOverview(req.user, fromTo(req.validatedQuery)))));

router.get('/categories', asyncHandler(async (req, res) => ok(res, await (await import('../services/categories.js')).listCategories())));

// ------------------------------------------------------------------ events
router.get('/events', validate({ query: pageQuery.extend({ status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'CANCELLED', 'SUSPENDED']).optional(), q: z.string().trim().max(100).optional() }) }), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const { total, items } = await events.organizerEventList(req.user, q);
  page(res, items, total, q);
}));

router.post('/events', requireOrganizer, validate({ body: v.eventBody }), asyncHandler(async (req, res) => ok(res, await events.createEvent(req.user, req.body, req.ip), undefined, 201)));

router.get('/events/:eventId', validate({ params: ev }), asyncHandler(async (req, res) => ok(res, await events.getEventForEdit(await requireEvent(req.user, req.params.eventId, 'view')))));

router.patch('/events/:eventId', validate({ params: ev, body: v.eventBody }), asyncHandler(async (req, res) => {
  const access = await requireEvent(req.user, req.params.eventId, 'manage');
  ok(res, await events.updateEvent(req.user, access, req.body, req.ip));
}));

router.get('/events/:eventId/checklist', validate({ params: ev }), asyncHandler(async (req, res) => {
  const access = await requireEvent(req.user, req.params.eventId, 'manage');
  ok(res, await events.publishChecklist(access.event, req.user));
}));

router.post('/events/:eventId/publish', validate({ params: ev }), asyncHandler(async (req, res) => ok(res, await events.publishEvent(req.user, await requireEvent(req.user, req.params.eventId, 'publish'), req.ip))));
router.post('/events/:eventId/unpublish', validate({ params: ev }), asyncHandler(async (req, res) => ok(res, await events.unpublishEvent(req.user, await requireEvent(req.user, req.params.eventId, 'publish'), req.ip))));
router.post('/events/:eventId/duplicate', requireOrganizer, validate({ params: ev }), asyncHandler(async (req, res) => ok(res, await events.duplicateEvent(req.user, await requireEvent(req.user, req.params.eventId, 'publish'), req.ip), undefined, 201)));
router.post('/events/:eventId/cancel', validate({ params: ev, body: v.cancelBody }), asyncHandler(async (req, res) => {
  const access = await requireEvent(req.user, req.params.eventId, 'publish');
  ok(res, await events.cancelEvent(req.user, access.event, req.body.reason, req.ip));
}));
router.post('/events/:eventId/announce', validate({ params: ev, body: v.announceBody }), asyncHandler(async (req, res) => {
  const access = await requireEvent(req.user, req.params.eventId, 'manage');
  ok(res, { notified: await events.notifyAttendees(access.event, req.body.message) });
}));

// images
router.post('/events/:eventId/banner', uploadLimiter, validate({ params: ev }), upload.single('file'), asyncHandler(async (req, res) => {
  const access = await requireEvent(req.user, req.params.eventId, 'manage');
  if (!req.file) throw badRequest('Choose an image to upload');
  const url = await saveImage(req.file.buffer, 'banners', { maxWidth: 2000, maxHeight: 1200 });
  await events.setBanner(access, url);
  ok(res, { url });
}));
router.post('/events/:eventId/images', uploadLimiter, validate({ params: ev }), upload.single('file'), asyncHandler(async (req, res) => {
  const access = await requireEvent(req.user, req.params.eventId, 'manage');
  if (!req.file) throw badRequest('Choose an image to upload');
  const url = await saveImage(req.file.buffer, 'gallery', { maxWidth: 1600, maxHeight: 1600 });
  ok(res, await events.addEventImage(access, url, String(req.body?.alt ?? '').slice(0, 120)), undefined, 201);
}));
router.delete('/events/:eventId/images/:imageId', validate({ params: ev.extend({ imageId: id }) }), asyncHandler(async (req, res) => {
  await events.removeEventImage(await requireEvent(req.user, req.params.eventId, 'manage'), req.params.imageId);
  ok(res, {});
}));

// ticket types (price + inventory edits are audited inside the service)
router.post('/events/:eventId/ticket-types', validate({ params: ev, body: v.ticketTypeBody }), asyncHandler(async (req, res) => ok(res, await events.createTicketType(req.user, await requireEvent(req.user, req.params.eventId, 'manage'), req.body, req.ip), undefined, 201)));
router.patch('/events/:eventId/ticket-types/:ticketTypeId', validate({ params: ev.extend({ ticketTypeId: id }), body: v.ticketTypeUpdateBody }), asyncHandler(async (req, res) => ok(res, await events.updateTicketType(req.user, await requireEvent(req.user, req.params.eventId, 'manage'), req.params.ticketTypeId, req.body, req.ip))));
router.delete('/events/:eventId/ticket-types/:ticketTypeId', validate({ params: ev.extend({ ticketTypeId: id }) }), asyncHandler(async (req, res) => ok(res, await events.removeTicketType(req.user, await requireEvent(req.user, req.params.eventId, 'manage'), req.params.ticketTypeId, req.ip))));

// discounts
router.post('/events/:eventId/discounts', validate({ params: ev, body: v.discountBody }), asyncHandler(async (req, res) => ok(res, await events.createDiscount(req.user, await requireEvent(req.user, req.params.eventId, 'finance'), req.body, req.ip), undefined, 201)));
router.patch('/events/:eventId/discounts/:discountId', validate({ params: ev.extend({ discountId: id }), body: z.object({ active: z.boolean() }).strict() }), asyncHandler(async (req, res) => ok(res, await events.setDiscountActive(req.user, await requireEvent(req.user, req.params.eventId, 'finance'), req.params.discountId, req.body.active))));

// analytics / activity
router.get('/events/:eventId/analytics', validate({ params: ev, query: a.rangeQuery }), asyncHandler(async (req, res) => ok(res, await analytics.eventAnalytics(await requireEvent(req.user, req.params.eventId, 'view'), fromTo(req.validatedQuery)))));
router.get('/events/:eventId/activity', validate({ params: ev }), asyncHandler(async (req, res) => ok(res, await staff.staffActivity(await requireEvent(req.user, req.params.eventId, 'staff')))));

// ------------------------------------------------------------------ attendees
const attQuery = pageQuery.extend({ q: z.string().trim().max(100).optional(), ticketTypeId: id.optional(), checkedIn: z.enum(['yes', 'no']).optional() });
router.get('/events/:eventId/attendees', validate({ params: ev, query: attQuery }), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const r = await orders.listAttendees({ user: req.user, eventId: req.params.eventId, ...q });
  page(res, r.items, r.total, q);
}));
router.get('/events/:eventId/attendees.csv', validate({ params: ev, query: attQuery }), asyncHandler(async (req, res) => {
  const r = await orders.listAttendees({ user: req.user, eventId: req.params.eventId, ...req.validatedQuery, all: true });
  await audit({ actor: req.user, action: 'attendees.export', entityType: 'Event', entityId: req.params.eventId, eventId: req.params.eventId, after: { rows: r.items.length }, ip: req.ip });
  sendCsv(res, `attendees-${req.params.eventId}.csv`, toCsv(r.items.map((t) => ({ ...t, checkedIn: t.checkedInAt ? 'Yes' : 'No' })), [{ key: 'number', label: 'Ticket' }, { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'ticketType', label: 'Type' }, { key: 'orderReference', label: 'Order' }, { key: 'checkedIn', label: 'Checked in' }, { key: 'checkedInAt', label: 'Checked in at' }]));
}));

// ------------------------------------------------------------------ sales / orders (owner only)
router.get('/orders', validate({ query: a.orgListQuery }), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const r = await orders.organizerOrders({ user: req.user, eventId: q.eventId, ...q });
  page(res, r.items, r.total, q);
}));
router.get('/orders.csv', validate({ query: a.orgListQuery }), asyncHandler(async (req, res) => {
  const q = { ...req.validatedQuery, page: 1, pageSize: 5000 };
  const r = await orders.organizerOrders({ user: req.user, eventId: q.eventId, ...q });
  await audit({ actor: req.user, action: 'orders.export', entityType: 'Order', after: { rows: r.items.length, eventId: q.eventId ?? null }, ip: req.ip });
  sendCsv(res, 'sales.csv', toCsv(r.items, [{ key: 'reference', label: 'Order' }, { key: 'eventTitle', label: 'Event' }, { key: 'customerName', label: 'Customer' }, { key: 'customerEmail', label: 'Email' }, { key: 'tickets', label: 'Tickets' }, { key: 'quantity', label: 'Qty' }, { key: 'total', label: 'Total' }, { key: 'commission', label: 'Platform commission' }, { key: 'gatewayFee', label: 'Processing fee (if reported)' }, { key: 'organizerNet', label: 'Organizer net' }, { key: 'refundedTotal', label: 'Refunded' }, { key: 'status', label: 'Status' }, { key: 'purchasedAt', label: 'Purchased' }]));
}));
router.get('/orders/:reference', asyncHandler(async (req, res) => ok(res, await orders.organizerOrderDetail(req.user, req.params.reference))));
router.post('/orders/:reference/resend', asyncHandler(async (req, res) => ok(res, { queued: await orders.resendForOrganizer(req.user, req.params.reference) })));
router.post('/orders/:reference/refund', validate({ body: a.initiateRefundBody }), asyncHandler(async (req, res) => {
  const order = await orders.organizerOrderDetail(req.user, req.params.reference);
  ok(res, await refunds.initiateRefund({ actor: req.user, orderId: order.id, organizerId: req.user.organizer?.id, ...req.body }));
}));

// ------------------------------------------------------------------ refunds review
router.get('/refunds', requireOrganizer, asyncHandler(async (req, res) => {
  ok(res, await prisma.refund.findMany({ where: { order: { event: { organizerId: req.user.organizer.id } } }, orderBy: { createdAt: 'desc' }, take: 100, include: { order: { select: { reference: true, buyerEmail: true, currency: true, event: { select: { title: true } } } } } }));
}));
router.post('/refunds/:refundId/review', requireOrganizer, validate({ params: z.object({ refundId: id }), body: a.reviewBody }), asyncHandler(async (req, res) => {
  ok(res, await refunds.reviewRefund({ actor: req.user, refundId: req.params.refundId, allowedOrganizerId: req.user.organizer.id, ...req.body }));
}));

// ------------------------------------------------------------------ staff
router.get('/events/:eventId/staff', validate({ params: ev }), asyncHandler(async (req, res) => ok(res, await staff.listStaff(await requireEvent(req.user, req.params.eventId, 'staff')))));
router.post('/events/:eventId/staff', validate({ params: ev, body: a.staffInviteBody }), asyncHandler(async (req, res) => {
  const inv = await staff.inviteStaff({ user: req.user, access: await requireEvent(req.user, req.params.eventId, 'staff'), ...req.body, ip: req.ip });
  ok(res, { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt }, undefined, 201);
}));
router.delete('/events/:eventId/staff/:staffId', validate({ params: ev.extend({ staffId: id }) }), asyncHandler(async (req, res) => { await staff.removeStaff({ user: req.user, access: await requireEvent(req.user, req.params.eventId, 'staff'), staffId: req.params.staffId, ip: req.ip }); ok(res, {}); }));
router.delete('/events/:eventId/invitations/:inviteId', validate({ params: ev.extend({ inviteId: id }) }), asyncHandler(async (req, res) => { await staff.revokeInvite({ user: req.user, access: await requireEvent(req.user, req.params.eventId, 'staff'), inviteId: req.params.inviteId, ip: req.ip }); ok(res, {}); }));
router.post('/staff/accept', validate({ body: z.object({ token: z.string().min(20).max(200) }).strict() }), asyncHandler(async (req, res) => ok(res, await staff.acceptInvitation({ user: req.user, token: req.body.token, ip: req.ip }))));

// appeals
router.post('/events/:eventId/appeal', validate({ params: ev, body: a.appealBody }), asyncHandler(async (req, res) => ok(res, await admin.createAppeal(req.user, await requireEvent(req.user, req.params.eventId, 'publish'), req.body.message), undefined, 201)));

// ------------------------------------------------------------------ money: balance, payout details, settlements (owner only)
router.get('/finance', requireOrganizer, asyncHandler(async (req, res) => {
  const org = await prisma.organizerProfile.findUnique({ where: { id: req.user.organizer.id } });
  const [bal, list] = await Promise.all([organizerBalance(org.id), settlements.listSettlements({ organizerId: org.id, page: 1, pageSize: 50 })]);
  ok(res, {
    balance: bal.formatted,
    explanation: 'Balances are accounting figures owed to you by the platform. They are not paid until a payout is marked PAID. New sales stay "pending" until the event ends plus the refund-risk hold.',
    payoutDetails: { bankName: org.payoutBankName, accountName: org.payoutAccountName, accountLast4: org.payoutAccountLast4 }, settlements: list.items,
  });
}));
router.put('/payout-details', requireOrganizer, validate({ body: a.payoutDetailsBody }), asyncHandler(async (req, res) => {
  if (!req.user.emailVerifiedAt) throw forbidden('Verify your email before saving payout details', 'EMAIL_NOT_VERIFIED');
  const b = req.body;
  await prisma.organizerProfile.update({ where: { id: req.user.organizer.id }, data: { payoutBankName: b.bankName, payoutAccountName: b.accountName, payoutAccountLast4: b.accountNumber.slice(-4), payoutAccountEnc: encrypt(b.accountNumber) } });
  await audit({ actor: req.user, action: 'organizer.payout_details_update', entityType: 'OrganizerProfile', entityId: req.user.organizer.id, after: { bankName: b.bankName, last4: b.accountNumber.slice(-4) }, ip: req.ip });
  ok(res, { saved: true });
}));
router.post('/settlements', requireOrganizer, validate({ body: a.settlementRequestBody }), asyncHandler(async (req, res) => ok(res, await settlements.requestSettlement({ actor: req.user, organizerId: req.user.organizer.id, ...req.body }), undefined, 201)));

router.patch('/profile', requireOrganizer, validate({ body: a.brandBody }), asyncHandler(async (req, res) => {
  const p = await prisma.organizerProfile.update({ where: { id: req.user.organizer.id }, data: req.body });
  ok(res, { brandName: p.brandName, bio: p.bio, website: p.website, supportEmail: p.supportEmail });
}));
router.post('/profile/logo', requireOrganizer, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Choose an image');
  const url = await saveImage(req.file.buffer, 'logos', { maxWidth: 512, maxHeight: 512 });
  await prisma.organizerProfile.update({ where: { id: req.user.organizer.id }, data: { logoUrl: url } });
  ok(res, { url });
}));

// events the user may scan (owned + staffed), for the scanner picker
router.get('/scannable-events', asyncHandler(async (req, res) => {
  const { owned, staffed } = await listAccessibleEventIds(req.user);
  const rows = await prisma.event.findMany({
    where: { id: { in: [...owned, ...staffed] }, status: { in: ['PUBLISHED', 'UNPUBLISHED'] }, endsAt: { gte: new Date(Date.now() - 86_400_000) } },
    orderBy: { startsAt: 'asc' }, select: { id: true, title: true, startsAt: true, city: true, venueName: true },
  });
  const out = [];
  for (const e of rows) { const access = await getEventAccess(req.user, e.id); if (access.can.scan) out.push(e); }
  ok(res, out);
}));

export default router;
