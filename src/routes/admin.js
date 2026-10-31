import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { ok, page } from '../lib/http.js';
import { toCsv, sendCsv } from '../utils/csv.js';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import * as admin from '../services/admin.js';
import * as analytics from '../services/analytics.js';
import * as settlements from '../services/settlements.js';
import * as refunds from '../services/refunds.js';
import * as recon from '../services/reconcile.js';
import { saveCategory, listCategories } from '../services/categories.js';
import { getSettings, updateSettings, invalidateSettingsCache } from '../services/settings.js';
import { paymentsStatus } from '../services/payments/index.js';
import { emailStats, retryFailedEmails, queueEmail, processEmailQueue } from '../services/email.js';
import { audit } from '../services/audit.js';
import * as a from '../validators/admin.js';
import { id, pageQuery, isoDate } from '../validators/common.js';

const router = Router();
router.use(requireRole('ADMIN'));

const q = pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.string().max(30).optional(), role: z.enum(['CUSTOMER', 'ORGANIZER', 'ADMIN']).optional(), eventId: id.optional() });
const range = a.rangeQuery;
const dates = z.object({ from: isoDate, to: isoDate });
const R = (x) => ({ from: x.from ?? new Date(Date.now() - 30 * 86_400_000), to: x.to ?? new Date() });

// overview + finance
router.get('/overview', validate({ query: range }), asyncHandler(async (req, res) => ok(res, await analytics.platformOverview({ ...req.validatedQuery, preset: req.validatedQuery.preset === 'custom' ? undefined : req.validatedQuery.preset }))));
router.get('/overview/series', validate({ query: range }), asyncHandler(async (req, res) => ok(res, await analytics.platformSeries({ ...req.validatedQuery, preset: req.validatedQuery.preset === 'custom' ? undefined : req.validatedQuery.preset }))));
router.get('/system', asyncHandler(async (req, res) => ok(res, { payments: paymentsStatus(), email: await emailStats(), webhooks: await prisma.paymentWebhookEvent.groupBy({ by: ['status'], _count: true }) })));

// users & organizers
router.get('/users', validate({ query: q }), asyncHandler(async (req, res) => { const r = await admin.listUsers(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));
router.get('/users/:id', validate({ params: z.object({ id }) }), asyncHandler(async (req, res) => ok(res, await admin.getUserDetail(req.params.id))));
router.post('/users/:id/status', validate({ params: z.object({ id }), body: a.statusBody }), asyncHandler(async (req, res) => { await admin.setUserStatus(req.user, req.params.id, req.body.status, req.body.reason, req.ip); ok(res, {}); }));
router.get('/organizers', validate({ query: q }), asyncHandler(async (req, res) => { const r = await admin.listOrganizersWithBalances(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));
router.post('/organizers/:id/suspend', validate({ params: z.object({ id }), body: a.orgSuspendBody }), asyncHandler(async (req, res) => { await admin.setOrganizerSuspended(req.user, req.params.id, req.body.suspended, req.body.reason, req.ip); ok(res, {}); }));
router.get('/organizers/:id/payout-details', validate({ params: z.object({ id }) }), asyncHandler(async (req, res) => ok(res, await admin.organizerPayoutDetails(req.params.id, req.user, req.ip))));

// events & moderation
router.get('/events', validate({ query: q }), asyncHandler(async (req, res) => { const r = await admin.listAdminEvents(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));
router.post('/events/:id/moderate', validate({ params: z.object({ id }), body: a.moderateBody }), asyncHandler(async (req, res) => ok(res, await admin.moderateEvent(req.user, req.params.id, req.body, req.ip))));
router.post('/events/:id/cancel', validate({ params: z.object({ id }), body: z.object({ reason: z.string().trim().min(5).max(500) }).strict() }), asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) throw badRequest('Unknown event');
  ok(res, await (await import('../services/events.js')).cancelEvent(req.user, event, req.body.reason, req.ip));
}));
router.put('/events/:id/commission', validate({ params: z.object({ id }), body: a.commissionOverrideBody }), asyncHandler(async (req, res) => {
  const s = await getSettings();
  if (!s.allowEventCommissionOverride) throw badRequest('Event-specific commission overrides are disabled in settings');
  ok(res, await admin.setEventCommission(req.user, req.params.id, req.body, req.ip));
}));
router.get('/events/:id/history', validate({ params: z.object({ id }) }), asyncHandler(async (req, res) => ok(res, await admin.eventHistory(req.params.id))));

router.get('/reports', validate({ query: q }), asyncHandler(async (req, res) => { const r = await admin.listReports(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));
router.post('/reports/:id/resolve', validate({ params: z.object({ id }), body: a.reportResolveBody }), asyncHandler(async (req, res) => ok(res, await admin.resolveReport(req.user, req.params.id, req.body, req.ip))));
router.get('/appeals', validate({ query: q }), asyncHandler(async (req, res) => { const r = await admin.listAppeals(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));
router.post('/appeals/:id/decide', validate({ params: z.object({ id }), body: a.appealDecisionBody }), asyncHandler(async (req, res) => { await admin.decideAppeal(req.user, req.params.id, req.body, req.ip); ok(res, {}); }));
router.get('/support', validate({ query: q }), asyncHandler(async (req, res) => { const r = await admin.listSupport(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));
router.post('/support/:id/reply', validate({ params: z.object({ id }), body: a.supportReplyBody }), asyncHandler(async (req, res) => { await admin.replySupport(req.user, req.params.id, req.body.reply, req.ip); ok(res, {}); }));

// orders, payments, refunds
router.get('/orders', validate({ query: q }), asyncHandler(async (req, res) => { const r = await admin.adminOrders(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));
router.get('/orders/:reference', asyncHandler(async (req, res) => ok(res, await admin.adminOrderDetail(req.params.reference))));
router.post('/orders/:reference/resolve', validate({ body: a.orderResolveBody }), asyncHandler(async (req, res) => ok(res, { outcome: await admin.resolveOrder(req.user, req.params.reference, req.body.action, req.ip) })));
router.get('/refunds', asyncHandler(async (req, res) => ok(res, await refunds.listOrderRefundsForAdmin(req.query.status ? { status: String(req.query.status) } : {}))));
router.post('/refunds/:id/review', validate({ params: z.object({ id }), body: a.reviewBody }), asyncHandler(async (req, res) => ok(res, await refunds.reviewRefund({ actor: req.user, refundId: req.params.id, ...req.body }))));
router.post('/refunds/:id/retry', validate({ params: z.object({ id }) }), asyncHandler(async (req, res) => ok(res, await refunds.processRefund(req.params.id))));
// Documented manual completion: only when Bachs confirmed the refund outside the webhook (e.g. missed delivery). Requires a bank/Bachs reference.
router.post('/refunds/:id/complete-manually', validate({ params: z.object({ id }), body: a.manualRefundBody }), asyncHandler(async (req, res) => {
  await audit({ actor: req.user, action: 'refund.manual_completion_requested', entityType: 'Refund', entityId: req.params.id, after: req.body, ip: req.ip });
  ok(res, await refunds.completeRefund(req.params.id, { source: 'manual', actor: req.user, reference: req.body.reference }));
}));

// settlements / payouts (manual, audited)
router.get('/settlements', validate({ query: q }), asyncHandler(async (req, res) => { const r = await settlements.listSettlements({ ...req.validatedQuery, organizerId: undefined }); page(res, r.items, r.total, req.validatedQuery); }));
router.post('/settlements', validate({ body: a.adminSettlementBody }), asyncHandler(async (req, res) => ok(res, await settlements.requestSettlement({ actor: req.user, organizerId: req.body.organizerId, amount: req.body.amount, note: req.body.note }), undefined, 201)));
router.post('/settlements/:id/approve', validate({ params: z.object({ id }) }), asyncHandler(async (req, res) => ok(res, await settlements.approveSettlement(req.user, req.params.id))));
router.post('/settlements/:id/reject', validate({ params: z.object({ id }), body: a.settlementRejectBody }), asyncHandler(async (req, res) => { await settlements.rejectSettlement(req.user, req.params.id, req.body.note); ok(res, {}); }));
router.post('/settlements/:id/paid', validate({ params: z.object({ id }), body: a.settlementPaidBody }), asyncHandler(async (req, res) => { await settlements.markSettlementPaid(req.user, req.params.id, req.body.externalReference); ok(res, {}); }));

// reconciliation & reports
router.get('/reconciliation', asyncHandler(async (req, res) => ok(res, await recon.discrepancyReport())));
router.post('/reconciliation/run', asyncHandler(async (req, res) => ok(res, { pending: await recon.reconcilePendingPayments(), expiry: await recon.expireDueOrders(), webhooks: await recon.retryFailedWebhookEvents() })));
router.get('/reports/commission', validate({ query: dates }), asyncHandler(async (req, res) => ok(res, await admin.commissionReport(R(req.validatedQuery)))));
router.get('/reports/commission.csv', validate({ query: dates }), asyncHandler(async (req, res) => {
  const rows = await admin.commissionReport(R(req.validatedQuery));
  await audit({ actor: req.user, action: 'report.export_commission', entityType: 'Report', after: { rows: rows.length }, ip: req.ip });
  sendCsv(res, 'commission-report.csv', toCsv(rows, [{ key: 'brandName', label: 'Organizer' }, { key: 'title', label: 'Event' }, { key: 'orders', label: 'Orders' }, { key: 'gross', label: 'Gross sales' }, { key: 'refunded', label: 'Refunded' }, { key: 'commission', label: 'Commission charged' }, { key: 'reversed', label: 'Commission reversed' }, { key: 'commissionNet', label: 'Commission (net)' }, { key: 'fees', label: 'Gateway fees (reported)' }, { key: 'organizerNet', label: 'Organizer net earnings' }]));
}));
router.get('/reports/ledger.csv', validate({ query: dates }), asyncHandler(async (req, res) => {
  const rows = (await admin.ledgerExport(R(req.validatedQuery))).map((l) => ({ createdAt: l.createdAt, organizer: l.organizer.brandName, type: l.type, amount: l.amount.toString(), currency: l.currency, order: l.order?.reference ?? '', availableAt: l.availableAt, memo: l.memo, key: l.idempotencyKey }));
  await audit({ actor: req.user, action: 'report.export_ledger', entityType: 'Report', after: { rows: rows.length }, ip: req.ip });
  sendCsv(res, 'organizer-ledger.csv', toCsv(rows, [{ key: 'createdAt', label: 'Date' }, { key: 'organizer', label: 'Organizer' }, { key: 'type', label: 'Type' }, { key: 'amount', label: 'Amount (+ owed to organizer / - reduces)' }, { key: 'currency', label: 'Currency' }, { key: 'order', label: 'Order' }, { key: 'availableAt', label: 'Available from' }, { key: 'memo', label: 'Memo' }, { key: 'key', label: 'Entry key' }]));
}));
router.get('/audit', validate({ query: pageQuery.extend({ action: z.string().max(60).optional(), entityType: z.string().max(40).optional(), actorId: id.optional(), eventId: id.optional() }) }), asyncHandler(async (req, res) => { const r = await admin.listAudit(req.validatedQuery); page(res, r.items, r.total, req.validatedQuery); }));

// settings, categories, announcements, email
router.get('/settings', asyncHandler(async (req, res) => ok(res, { settings: await getSettings({ fresh: true }), categories: await listCategories({ all: true }), payments: paymentsStatus() })));
router.patch('/settings', asyncHandler(async (req, res) => ok(res, await updateSettings(req.body ?? {}, req.user, req.ip))));
router.post('/categories', validate({ body: a.categoryBody.required({ name: true }) }), asyncHandler(async (req, res) => ok(res, await saveCategory(req.user, null, req.body, req.ip), undefined, 201)));
router.patch('/categories/:id', validate({ params: z.object({ id }), body: a.categoryBody }), asyncHandler(async (req, res) => ok(res, await saveCategory(req.user, req.params.id, req.body, req.ip))));
router.get('/announcements', asyncHandler(async (req, res) => ok(res, await admin.listAnnouncements())));
router.post('/announcements', validate({ body: a.announcementBody }), asyncHandler(async (req, res) => ok(res, await admin.saveAnnouncement(req.user, null, req.body, req.ip), undefined, 201)));
router.patch('/announcements/:id', validate({ params: z.object({ id }), body: a.announcementBody.partial() }), asyncHandler(async (req, res) => { invalidateSettingsCache(); ok(res, await admin.saveAnnouncement(req.user, req.params.id, req.body, req.ip)); }));
router.get('/email/log', asyncHandler(async (req, res) => ok(res, await prisma.emailDeliveryLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, toEmail: true, subject: true, template: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true } }))));
router.post('/email/retry-failed', asyncHandler(async (req, res) => ok(res, { requeued: await retryFailedEmails() })));
router.post('/email/test', asyncHandler(async (req, res) => {
  await queueEmail(prisma, { to: req.user.email, template: 'test_email', data: {}, dedupeKey: `test:${Date.now()}` });
  ok(res, await processEmailQueue({ limit: 5 }));
}));

export default router;
