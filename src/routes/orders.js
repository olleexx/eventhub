import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound } from '../lib/errors.js';
import { ok, noStore } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { checkoutLimiter, authLimiter } from '../middleware/security.js';
import { createCheckout } from '../services/checkout.js';
import { getOrderForViewer, qrDataUrl, buildTicketsPdf, listUserTickets } from '../services/tickets.js';
import { customerOrders, requestTicketResend } from '../services/orders.js';
import { requestRefund } from '../services/refunds.js';
import { reconcilePayment } from '../services/reconcile.js';
import { listFavorites } from '../services/events.js';
import { getSettings } from '../services/settings.js';
import { prisma } from '../lib/prisma.js';
import { checkoutBody, lookupBody, refundRequestBody } from '../validators/checkout.js';

const router = Router();
const refParam = z.object({ reference: z.string().regex(/^ORD-[A-Z0-9]{6,20}$/) });
const tokenOf = (req) => (typeof req.query.token === 'string' ? req.query.token.slice(0, 100) : undefined);

// Throttle active gateway verification triggered by the return page (per order, in-memory is fine: it is only an optimisation).
const lastVerify = new Map();

router.post('/checkout', checkoutLimiter, validate({ body: checkoutBody }), asyncHandler(async (req, res) => {
  noStore(res);
  ok(res, await createCheckout({ user: req.user, input: req.body, ip: req.ip }), undefined, 201);
}));

router.post('/orders/lookup', authLimiter, validate({ body: lookupBody }), asyncHandler(async (req, res) => {
  await requestTicketResend(req.body.email);
  ok(res, { message: 'If that email has recent orders, we have sent the tickets to it.' });
}));

async function presentOrder(order, { withQr }) {
  const live = order.tickets;
  const tickets = [];
  if (['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.status)) {
    for (const t of live) tickets.push({ id: t.id, number: t.number, status: t.status, type: t.ticketType.name, holderName: t.holderName, checkedInAt: t.checkedInAt, qr: withQr && ['VALID', 'USED'].includes(t.status) ? await qrDataUrl(t.code) : null });
  }
  const e = order.event;
  return {
    reference: order.reference, status: order.status, total: order.total.toString(), currency: order.currency, paidAt: order.paidAt, reservedUntil: order.reservedUntil,
    refundedTotal: order.refundedTotal.toString(), buyerName: order.buyerName, buyerEmail: order.buyerEmail,
    items: order.items.map((i) => ({ name: i.ticketType.name, quantity: i.quantity, unitPrice: i.unitPrice.toString(), lineTotal: i.lineTotal.toString() })),
    event: { title: e.title, slug: e.slug, startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone, venueName: e.venueName, address: e.address, city: e.city, onlineUrl: e.onlineUrl, bannerUrl: e.bannerUrl, entryInstructions: e.entryInstructions, refundPolicy: e.refundPolicy, status: e.status, refundDeadline: e.refundDeadline },
    tickets,
    refunds: order.refunds.map((r) => ({ id: r.id, status: r.status, amount: r.amount.toString(), reason: r.reason, createdAt: r.createdAt })),
    canRequestRefund: order.status === 'PAID' && Boolean(e.refundDeadline && e.refundDeadline > new Date()) && e.status !== 'CANCELLED' && !order.refunds.some((r) => ['REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED'].includes(r.status)),
  };
}

router.get('/orders/:reference', validate({ params: refParam }), asyncHandler(async (req, res) => {
  noStore(res);
  const args = { reference: req.params.reference, token: tokenOf(req), user: req.user };
  let order = await getOrderForViewer(args);
  if (order.status === 'PENDING' && req.query.return) {
    // The browser redirect is only a hint. Ask the gateway (server-to-server) whether it was paid.
    const last = lastVerify.get(order.id) ?? 0;
    const payment = await prisma.payment.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
    if (payment?.gatewayCheckoutId && Date.now() - last > 4000) {
      lastVerify.set(order.id, Date.now());
      await reconcilePayment(payment.id, 'return-page').catch(() => {});
      order = await getOrderForViewer(args);
    }
  }
  ok(res, await presentOrder(order, { withQr: true }));
}));

router.get('/orders/:reference/tickets.pdf', validate({ params: refParam }), asyncHandler(async (req, res) => {
  noStore(res);
  const order = await getOrderForViewer({ reference: req.params.reference, token: tokenOf(req), user: req.user });
  const live = order.tickets.filter((t) => ['VALID', 'USED'].includes(t.status));
  if (!live.length) throw notFound('No valid tickets on this order');
  const settings = await getSettings();
  const full = await prisma.event.findUnique({ where: { id: order.eventId } });
  const pdf = await buildTicketsPdf({ tickets: live, event: full, order, platformName: settings.platformName });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="tickets-${order.reference}.pdf"`);
  res.send(pdf);
}));

router.post('/orders/:reference/refund-request', authLimiter, validate({ params: refParam, body: refundRequestBody }), asyncHandler(async (req, res) => {
  const order = await getOrderForViewer({ reference: req.params.reference, token: tokenOf(req), user: req.user });
  const r = await requestRefund({ order, user: req.user, ticketIds: req.body.ticketIds, reason: req.body.reason });
  ok(res, { id: r.id, status: r.status, amount: r.amount.toString() }, undefined, 201);
}));

// ---- signed-in customer account
router.get('/me/orders', requireAuth, asyncHandler(async (req, res) => {
  const rows = await customerOrders(req.user);
  ok(res, rows.map((o) => ({ reference: o.reference, status: o.status, total: o.total.toString(), currency: o.currency, createdAt: o.createdAt, paidAt: o.paidAt, refundedTotal: o.refundedTotal.toString(), ticketCount: o._count.tickets, event: o.event })));
}));

router.get('/me/tickets', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserTickets(req.user.id, req.user.emailVerifiedAt ? req.user.email : '__unverified__');
  ok(res, await Promise.all(rows.map(async (t) => ({ id: t.id, number: t.number, status: t.status, type: t.ticketType.name, holderName: t.holderName, orderReference: t.order.reference, event: t.event, qr: t.status === 'VALID' ? await qrDataUrl(t.code, 260) : null }))));
}));

router.get('/me/favorites', requireAuth, asyncHandler(async (req, res) => ok(res, await listFavorites(req.user))));

export default router;
