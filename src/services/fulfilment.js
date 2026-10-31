// Fulfilment: turns a VERIFIED payment into tickets, commission and ledger entries, atomically and
// idempotently. Callers (webhook handler, reconciliation job, return-page poll) must first obtain
// `verified` from gateway.retrieveCheckout(): they never pass browser- or webhook-supplied claims.
//
// Guarantees:
//  * one DB transaction holds a row lock on the order (SELECT ... FOR UPDATE)
//  * a second call for an already-paid order is a no-op ("already")
//  * tickets, CommissionRecord (unique per order) and ledger entries (unique idempotencyKey) cannot
//    be created twice, even if two workers race
//  * payment after the reservation expired claims fresh capacity or parks the order for review and
//    auto-creates an approved full refund; it never issues more tickets than capacity allows
import { prisma, Prisma } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { log } from '../lib/logger.js';
import { toMinor, fromMinor } from '../lib/money.js';
import { randomToken, ticketNumber } from '../utils/crypto.js';
import { commitOrderInventory, recalcEventStats, CapacityError } from './inventory.js';
import { postEntries, availableAtFor } from './ledger.js';
import { queueEmail, kickEmailQueue } from './email.js';
import { getSettings } from './settings.js';
import { orderAccessToken } from '../utils/crypto.js';
import { audit } from './audit.js';
import { formatWhen } from './tickets.js';
import { formatMoney } from '../lib/money.js';

const PAID_STATES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const SELLABLE_EVENT_STATES = ['PUBLISHED', 'UNPUBLISHED', 'SCHEDULED', 'DRAFT'];

async function lockOrder(tx, orderId) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
}

async function enqueueTicketEmail(tx, order, event, ticketCount, dedupeSuffix = 'paid') {
  await queueEmail(tx, {
    to: order.buyerEmail,
    template: 'ticket_confirmation',
    dedupeKey: `ticket-confirmation:${order.id}:${dedupeSuffix}`,
    data: {
      orderId: order.id, reference: order.reference, buyerName: order.buyerName, eventTitle: event.title,
      when: formatWhen(event.startsAt, event.timezone), where: [event.venueName, event.address, event.city].filter(Boolean).join(', ') || (event.onlineUrl ? 'Online' : 'See event page'),
      total: formatMoney(order.total.toString(), order.currency), ticketCount,
      accessToken: orderAccessToken(order.reference, config.SESSION_SECRET),
    },
  });
}

/** Shared ticket issuance inside an existing transaction. */
async function issueTickets(tx, order, items, event) {
  const attendees = Array.isArray(order.attendeeInfo) ? order.attendeeInfo : [];
  const perTicket = attendees.length > 0 && attendees[0]?.name !== undefined; // per-ticket attendee list vs single answers blob
  const sharedAnswers = !perTicket && attendees[0]?.answers ? attendees[0].answers : {};
  let n = 0;
  const created = [];
  for (const item of items) {
    for (let i = 0; i < item.quantity; i++) {
      const a = perTicket ? attendees[n] : null;
      created.push(
        await tx.ticket.create({
          data: {
            code: randomToken(24), number: ticketNumber(), orderId: order.id, orderItemId: item.id, eventId: event.id, ticketTypeId: item.ticketTypeId,
            holderName: a?.name || order.buyerName, holderEmail: a?.email || order.buyerEmail, answers: a?.answers ?? sharedAnswers,
          },
        }),
      );
      n++;
    }
  }
  return created;
}

async function parkForReview(order, reason, { refund }) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order.id);
    const fresh = await tx.order.findUnique({ where: { id: order.id }, include: { event: true } });
    if (PAID_STATES.includes(fresh.status) || fresh.status === 'NEEDS_REVIEW') return;
    await tx.order.update({ where: { id: order.id }, data: { status: 'NEEDS_REVIEW', reviewNote: reason } });
    if (refund) {
      await tx.refund.createMany({
        data: [{ orderId: order.id, amount: fresh.total, reason: `Automatic full refund: ${reason}`, status: 'APPROVED', isEventCancellation: false, idempotencyKey: `review:${order.id}`, reviewNote: 'Automatic: could not fulfil verified payment' }],
        skipDuplicates: true,
      });
    }
    await queueEmail(tx, { to: fresh.buyerEmail, template: 'order_needs_review', data: { reference: fresh.reference, eventTitle: fresh.event.title, reason: reason.replace(/_/g, ' ') }, dedupeKey: `needs-review:${order.id}` });
    await audit({ actor: null, action: 'order.needs_review', entityType: 'Order', entityId: order.id, eventId: fresh.eventId, after: { reason, refundQueued: Boolean(refund) } }, tx);
  });
  kickEmailQueue();
}

/**
 * @param {{paymentId: string, verified: {status:string, amountMinor:number|null, currency:string|null, feeMinor:number|null, chargeId?:string|null}, source: string}} p
 * @returns {Promise<{outcome: 'fulfilled'|'already'|'needs_review'|'not_paid', orderId: string}>}
 */
export async function applyVerifiedPayment({ paymentId, verified, source }) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { order: { include: { items: true, event: true } } } });
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  const order = payment.order;

  if (verified.status !== 'succeeded') return { outcome: 'not_paid', orderId: order.id };
  if (PAID_STATES.includes(order.status)) return { outcome: 'already', orderId: order.id };

  // Amount + currency must match what WE priced. Missing data => cannot verify => never fulfil automatically.
  const expected = toMinor(order.total);
  if (verified.amountMinor == null || !verified.currency) {
    await prisma.payment.update({ where: { id: paymentId }, data: { lastGatewayStatus: 'unverifiable_response' } });
    await parkForReview(order, 'gateway_response_missing_amount_or_currency', { refund: false });
    return { outcome: 'needs_review', orderId: order.id };
  }
  if (verified.currency !== order.currency || verified.amountMinor !== expected) {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: verified.amountMinor < expected ? 'UNDERPAID' : payment.status, amountPaid: fromMinor(verified.amountMinor), lastGatewayStatus: `amount_mismatch:${verified.currency}`, failureReason: `Expected ${order.currency} ${fromMinor(expected)}, gateway reports ${verified.currency} ${fromMinor(verified.amountMinor)}` },
    });
    await parkForReview(order, 'amount_or_currency_mismatch', { refund: false });
    return { outcome: 'needs_review', orderId: order.id };
  }
  if (!SELLABLE_EVENT_STATES.includes(order.event.status)) {
    await parkForReview(order, `event_${order.event.status.toLowerCase()}`, { refund: true });
    return { outcome: 'needs_review', orderId: order.id };
  }

  const settings = await getSettings();
  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockOrder(tx, order.id);
      const o = await tx.order.findUnique({ where: { id: order.id }, include: { items: true } });
      if (PAID_STATES.includes(o.status)) return { already: true };
      if (o.status === 'NEEDS_REVIEW') return { review: true };

      const { late } = await commitOrderInventory(tx, o, o.items); // throws CapacityError => rollback

      const tickets = await issueTickets(tx, o, o.items, order.event);
      const commission = toMinor(o.commissionTotal);
      const total = toMinor(o.total);
      await tx.order.update({ where: { id: o.id }, data: { status: 'PAID', paidAt: new Date(), gatewayFee: verified.feeMinor != null ? fromMinor(verified.feeMinor) : undefined, reviewNote: late ? 'paid_after_reservation_expired_capacity_reclaimed' : null } });
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'SUCCEEDED', ...(verified.chargeId ? { gatewayChargeId: verified.chargeId } : {}), amountPaid: fromMinor(verified.amountMinor), gatewayFee: verified.feeMinor != null ? fromMinor(verified.feeMinor) : undefined, verifiedAt: new Date(), lastGatewayStatus: 'succeeded', failureReason: null, gatewayChargeId: verified.chargeId ?? payment.gatewayChargeId } });

      await tx.commissionRecord.createMany({
        data: [{ orderId: o.id, percent: o.commissionPercentApplied, fixedPerTicket: o.commissionFixedApplied, amount: fromMinor(commission), currency: o.currency }],
        skipDuplicates: true, // unique(orderId): the same transaction can never be charged twice
      });
      const availableAt = availableAtFor(order.event, settings.settlementHoldDays);
      await postEntries(tx, [
        { organizerId: order.event.organizerId, type: 'SALE', amount: fromMinor(total), currency: o.currency, orderId: o.id, availableAt, idempotencyKey: `sale:${o.id}`, memo: `Order ${o.reference}` },
        ...(commission > 0 ? [{ organizerId: order.event.organizerId, type: 'COMMISSION', amount: fromMinor(-commission), currency: o.currency, orderId: o.id, availableAt, idempotencyKey: `commission:${o.id}`, memo: `Platform commission, order ${o.reference}` }] : []),
      ]);
      await enqueueTicketEmail(tx, o, order.event, tickets.length);
      await recalcEventStats(tx, order.eventId);
      await audit({ actor: null, action: 'order.paid', entityType: 'Order', entityId: o.id, eventId: order.eventId, after: { source, tickets: tickets.length, total: fromMinor(total), commission: fromMinor(commission), late } }, tx);
      return { fulfilled: true };
    });
    if (result.already) return { outcome: 'already', orderId: order.id };
    if (result.review) return { outcome: 'needs_review', orderId: order.id };
    kickEmailQueue();
    return { outcome: 'fulfilled', orderId: order.id };
  } catch (err) {
    if (err instanceof CapacityError) {
      log.warn('paid_after_expiry_sold_out', { orderId: order.id });
      await prisma.payment.update({ where: { id: paymentId }, data: { status: 'SUCCEEDED', amountPaid: fromMinor(verified.amountMinor), verifiedAt: new Date(), lastGatewayStatus: 'succeeded_unfulfilled' } });
      await parkForReview(order, 'paid_after_expiry_sold_out', { refund: true });
      return { outcome: 'needs_review', orderId: order.id };
    }
    throw err;
  }
}

/** Free orders (total 0): same ticket issuance, no gateway, no commission, no ledger. */
export async function fulfilFreeOrder(orderId) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const o = await tx.order.findUnique({ where: { id: orderId }, include: { items: true, event: true } });
    if (!o || o.status !== 'PENDING') return;
    await commitOrderInventory(tx, o, o.items);
    const tickets = await issueTickets(tx, o, o.items, o.event);
    await tx.order.update({ where: { id: o.id }, data: { status: 'PAID', paidAt: new Date() } });
    await enqueueTicketEmail(tx, o, o.event, tickets.length);
    await recalcEventStats(tx, o.eventId);
    await audit({ actor: null, action: 'order.paid', entityType: 'Order', entityId: o.id, eventId: o.eventId, after: { source: 'free', tickets: tickets.length } }, tx);
  });
  kickEmailQueue();
}

/** Re-send the ticket email (customer lookup / organizer action). Deduplicated per 10-minute window. */
export async function resendTicketEmail(orderId) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { event: true, tickets: true } });
  if (!o || !['PAID', 'PARTIALLY_REFUNDED'].includes(o.status)) return false;
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  const queued = await prisma.$transaction((tx) => enqueueTicketEmail(tx, o, o.event, o.tickets.filter((t) => t.status === 'VALID' || t.status === 'USED').length, `resend:${bucket}`).then(() => true));
  kickEmailQueue();
  return queued;
}