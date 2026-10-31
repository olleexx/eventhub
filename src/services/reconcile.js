// Reconciliation and expiry. All functions are idempotent and safe to run concurrently/repeatedly.
import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { getGateway } from './payments/index.js';
import { applyVerifiedPayment } from './fulfilment.js';
import { cancelPendingOrder } from './checkout.js';

/** Ask the gateway for the truth about one payment and act on it. Returns the outcome string. */
export async function reconcilePayment(paymentId, source = 'reconcile') {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment?.gatewayCheckoutId) return 'no_checkout';
  const verified = await getGateway().retrieveCheckout(payment.gatewayCheckoutId);
  if (verified.status === 'succeeded') return (await applyVerifiedPayment({ paymentId, verified, source })).outcome;
  await prisma.payment.update({ where: { id: paymentId }, data: { lastGatewayStatus: verified.rawStatus || verified.status } });
  if (verified.status === 'failed' && payment.status !== 'SUCCEEDED') await prisma.payment.update({ where: { id: paymentId }, data: { status: 'FAILED' } });
  if (verified.status === 'expired') await cancelPendingOrder(payment.orderId, 'EXPIRED', 'gateway_expired');
  return verified.status;
}

/**
 * Release reservations that have lapsed. Before expiring an order that has a live gateway session,
 * ask the gateway: the customer may have paid and the webhook may simply be late.
 */
export async function expireDueOrders({ limit = 100 } = {}) {
  const due = await prisma.order.findMany({
    where: { status: 'PENDING', reservedUntil: { lt: new Date() } },
    include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    take: limit,
  });
  let expired = 0;
  let fulfilled = 0;
  for (const o of due) {
    const p = o.payments[0];
    if (p?.gatewayCheckoutId && p.status !== 'FAILED') {
      try {
        const out = await reconcilePayment(p.id, 'expiry-check');
        if (out === 'fulfilled' || out === 'already') { fulfilled++; continue; }
        if (out === 'needs_review') continue;
      } catch (err) {
        log.warn('expiry_gateway_check_failed', { orderId: o.id, err });
        // Gateway unreachable: leave the reservation for the next run rather than risk expiring a paid order.
        if (o.reservedUntil > new Date(Date.now() - 6 * 3600_000)) continue;
      }
    }
    if (await cancelPendingOrder(o.id, 'EXPIRED', 'reservation_expired')) expired++;
  }
  return { expired, fulfilled };
}

/** Payments stuck in INITIATED/PENDING for > 10 minutes: poll the gateway (webhook may have been missed). */
export async function reconcilePendingPayments({ limit = 50 } = {}) {
  const stale = await prisma.payment.findMany({
    where: { status: { in: ['INITIATED', 'PENDING'] }, gatewayCheckoutId: { not: null }, createdAt: { lt: new Date(Date.now() - 10 * 60_000), gt: new Date(Date.now() - 7 * 86_400_000) } },
    orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
  });
  const summary = {};
  for (const { id } of stale) {
    try { const out = await reconcilePayment(id); summary[out] = (summary[out] ?? 0) + 1; }
    catch (err) { summary.error = (summary.error ?? 0) + 1; log.warn('reconcile_failed', { paymentId: id, err }); }
  }
  return { checked: stale.length, ...summary };
}

/** Webhook events that failed processing and were never retried by the provider. */
export async function retryFailedWebhookEvents({ limit = 20 } = {}) {
  const rows = await prisma.paymentWebhookEvent.findMany({ where: { status: 'FAILED', attempts: { lt: 8 } }, orderBy: { receivedAt: 'asc' }, take: limit });
  let ok = 0;
  const { processStoredWebhook } = await import('./webhooks.js');
  for (const row of rows) { try { await processStoredWebhook(row); ok++; } catch { /* stays FAILED, visible to admins */ } }
  return ok;
}

export async function discrepancyReport() {
  const [paidNoTickets, succeededOrderNotPaid, staleReview, failedWebhooks, orphanedReservations] = await Promise.all([
    prisma.order.findMany({ where: { status: 'PAID', total: { gt: 0 }, tickets: { none: {} } }, select: { id: true, reference: true }, take: 50 }),
    prisma.payment.findMany({ where: { status: 'SUCCEEDED', order: { status: { notIn: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'NEEDS_REVIEW'] } } }, select: { id: true, orderId: true }, take: 50 }),
    prisma.order.findMany({ where: { status: 'NEEDS_REVIEW' }, select: { id: true, reference: true, reviewNote: true, updatedAt: true }, orderBy: { updatedAt: 'asc' }, take: 50 }),
    prisma.paymentWebhookEvent.findMany({ where: { status: 'FAILED' }, select: { id: true, eventId: true, type: true, error: true, attempts: true }, take: 50 }),
    prisma.$queryRaw`SELECT tt."id", tt."name", tt."quantityReserved", COALESCE(x.held, 0)::int AS held
                       FROM "TicketType" tt
                       LEFT JOIN (SELECT oi."ticketTypeId", SUM(oi."quantity") AS held FROM "OrderItem" oi JOIN "Order" o ON o."id" = oi."orderId" WHERE o."status" = 'PENDING' AND o."inventoryReleased" = false GROUP BY oi."ticketTypeId") x ON x."ticketTypeId" = tt."id"
                      WHERE tt."quantityReserved" <> COALESCE(x.held, 0) LIMIT 50`,
  ]);
  return { paidNoTickets, succeededOrderNotPaid, needsReview: staleReview, failedWebhooks, reservationMismatches: orphanedReservations };
}
