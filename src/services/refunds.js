// Refund lifecycle:  REQUESTED -> APPROVED -> PROCESSING -> COMPLETED   (or REJECTED / FAILED)
//
// * A request is NOT a refund. Money is only considered returned (ledger reversal, tickets
//   invalidated, order totals changed) in completeRefund(), which runs when Bachs confirms with a
//   signed refund.paid webhook, or when an admin records a documented manual completion.
// * Bachs permits ONE refund operation per charge (per the integration notes), so the app allows
//   one gateway refund per order. A partial refund therefore uses up the order's refund operation.
// * Inventory is NOT automatically returned to sale on refund (overselling/reservation risk);
//   organizers can raise the ticket quantity themselves, subject to the usual validation.
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { toMinor, fromMinor, formatMoney } from '../lib/money.js';
import { commissionReversal } from './commission.js';
import { postEntries } from './ledger.js';
import { getGateway, GatewayError } from './payments/index.js';
import { queueEmail, kickEmailQueue } from './email.js';
import { audit } from './audit.js';

const OPEN = ['REQUESTED', 'APPROVED', 'PROCESSING'];

function refundableTickets(order, ticketIds) {
  const live = order.tickets.filter((t) => t.status === 'VALID');
  const chosen = ticketIds?.length ? live.filter((t) => ticketIds.includes(t.id)) : live;
  if (ticketIds?.length && chosen.length !== new Set(ticketIds).size) throw badRequest('Some selected tickets cannot be refunded (already used, refunded or not part of this order)', undefined, 'TICKETS_NOT_REFUNDABLE');
  if (!chosen.length) throw badRequest('There are no refundable tickets on this order', undefined, 'TICKETS_NOT_REFUNDABLE');
  return { chosen, all: chosen.length === live.length && live.length === order.tickets.filter((t) => t.status !== 'CANCELLED').length };
}

/** Pro-rata refund amount for selected tickets (after discount), capped by what is still refundable. */
export function computeRefundAmount(order, chosenTickets, coversAll) {
  const remaining = toMinor(order.total) - toMinor(order.refundedTotal);
  if (coversAll) return remaining;
  let sum = 0;
  for (const t of chosenTickets) {
    const item = order.items.find((i) => i.id === t.orderItemId);
    sum += Math.round(toMinor(item.lineTotal) / item.quantity);
  }
  return Math.min(sum, remaining);
}

async function loadOrder(orderId) {
  return prisma.order.findUnique({ where: { id: orderId }, include: { event: true, items: true, tickets: true, refunds: true, payments: true } });
}

function assertGatewayRefundAvailable(order) {
  if (order.refunds.some((r) => r.gatewayRefundId || r.status === 'COMPLETED')) {
    throw conflict('A refund was already issued for this order. Contact support for further adjustments.', 'REFUND_LIMIT');
  }
}

/** Customer (or guest with access token) asks for a refund. Eligibility is enforced here, not in the UI. */
export async function requestRefund({ order, user, ticketIds, reason }) {
  const full = await loadOrder(order.id);
  if (!['PAID'].includes(full.status)) throw conflict('Only fully paid orders can be refunded', 'NOT_REFUNDABLE');
  if (full.event.status === 'CANCELLED') throw conflict('This event was cancelled; your refund is processed automatically.', 'EVENT_CANCELLED');
  if (!full.event.refundDeadline) throw conflict('The organizer does not offer refund requests for this event. See the refund policy on the event page.', 'REFUNDS_NOT_OFFERED');
  if (full.event.refundDeadline < new Date()) throw conflict('The refund request window for this event has closed.', 'REFUND_WINDOW_CLOSED');
  if (full.refunds.some((r) => OPEN.includes(r.status))) throw conflict('A refund request is already in progress for this order', 'REFUND_IN_PROGRESS');
  assertGatewayRefundAvailable(full);
  const { chosen, all } = refundableTickets(full, ticketIds);
  const amount = computeRefundAmount(full, chosen, all);
  if (amount <= 0) throw badRequest('Nothing left to refund');
  const refund = await prisma.refund.create({
    data: { orderId: full.id, requestedById: user?.id ?? null, amount: fromMinor(amount), reason, ticketIds: chosen.map((t) => t.id), status: 'REQUESTED', idempotencyKey: `req:${full.id}:${Date.now()}` },
  });
  await audit({ actor: user, action: 'refund.request', entityType: 'Refund', entityId: refund.id, eventId: full.eventId, after: { amount: fromMinor(amount), tickets: chosen.length } });
  return refund;
}

/** Organizer owner or platform admin approves/rejects. Organizer-initiated refunds skip the customer window. */
export async function reviewRefund({ actor, refundId, decision, note, allowedOrganizerId }) {
  const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { order: { include: { event: true } } } });
  if (!refund) throw notFound('Refund not found');
  if (actor.role !== 'ADMIN' && refund.order.event.organizerId !== allowedOrganizerId) throw notFound('Refund not found');
  if (refund.status !== 'REQUESTED') throw conflict(`This refund is already ${refund.status.toLowerCase()}`);
  const next = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  const upd = await prisma.refund.updateMany({ where: { id: refundId, status: 'REQUESTED' }, data: { status: next, reviewedById: actor.id, reviewNote: note ?? null } });
  if (upd.count === 0) throw conflict('This refund was already reviewed');
  await audit({ actor, action: `refund.${decision}`, entityType: 'Refund', entityId: refundId, eventId: refund.order.eventId, after: { note } });
  await queueEmail(prisma, { to: refund.order.buyerEmail, template: 'refund_status', data: { statusLabel: decision === 'approve' ? 'approved' : 'declined', amount: formatMoney(refund.amount.toString(), refund.order.currency), reference: refund.order.reference, eventTitle: refund.order.event.title, note: decision === 'approve' ? 'We are processing it now.' : note }, dedupeKey: `refund-${next}:${refundId}` });
  kickEmailQueue();
  if (decision === 'approve') await processRefund(refundId).catch((err) => log.warn('refund_process_failed', { refundId, err }));
  return prisma.refund.findUnique({ where: { id: refundId } });
}

/** Organizer/admin initiated refund (skips REQUESTED). */
export async function initiateRefund({ actor, orderId, ticketIds, reason, organizerId }) {
  const full = await loadOrder(orderId);
  if (!full || (actor.role !== 'ADMIN' && full.event.organizerId !== organizerId)) throw notFound('Order not found');
  if (full.status !== 'PAID') throw conflict('Only fully paid orders can be refunded', 'NOT_REFUNDABLE');
  if (full.refunds.some((r) => OPEN.includes(r.status))) throw conflict('A refund is already in progress for this order', 'REFUND_IN_PROGRESS');
  assertGatewayRefundAvailable(full);
  const { chosen, all } = refundableTickets(full, ticketIds);
  const amount = computeRefundAmount(full, chosen, all);
  const refund = await prisma.refund.create({
    data: { orderId, requestedById: actor.id, reviewedById: actor.id, amount: fromMinor(amount), reason, ticketIds: chosen.map((t) => t.id), status: 'APPROVED', idempotencyKey: `init:${orderId}:${Date.now()}` },
  });
  await audit({ actor, action: 'refund.initiate', entityType: 'Refund', entityId: refund.id, eventId: full.eventId, after: { amount: fromMinor(amount) } });
  await processRefund(refund.id).catch((err) => log.warn('refund_process_failed', { refundId: refund.id, err }));
  return prisma.refund.findUnique({ where: { id: refund.id } });
}

/** Call the gateway for an APPROVED (or previously FAILED) refund. Claimed with a conditional update => no double submit. */
export async function processRefund(refundId) {
  const claimed = await prisma.refund.updateMany({ where: { id: refundId, status: { in: ['APPROVED', 'FAILED'] } }, data: { status: 'PROCESSING', failureReason: null } });
  if (claimed.count === 0) return { skipped: true };
  const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { order: { include: { payments: true } } } });
  const payment = refund.order.payments.find((p) => p.status === 'SUCCEEDED') ?? refund.order.payments.find((p) => p.gatewayChargeId);
  if (payment && !payment.gatewayChargeId && payment.gatewayCheckoutId) {
    // Older orders (or a missed webhook): ask the gateway which charge paid this checkout.
    const looked = await getGateway().retrieveCheckout(payment.gatewayCheckoutId).catch(() => null);
    if (looked?.chargeId) payment.gatewayChargeId = (await prisma.payment.update({ where: { id: payment.id }, data: { gatewayChargeId: looked.chargeId } })).gatewayChargeId;
  }
  if (!payment?.gatewayChargeId) {
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: 'No gateway charge found for this order' } });
    return { failed: true };
  }
  const full = toMinor(refund.order.total) - toMinor(refund.order.refundedTotal);
  const amountMinor = toMinor(refund.amount);
  try {
    const res = await getGateway().createRefund({
      chargeId: payment.gatewayChargeId, amountMinor: amountMinor === full ? undefined : amountMinor, // omit => full refund
      reference: refund.id, reason: refund.reason?.slice(0, 200), idempotencyKey: refund.idempotencyKey,
    });
    await prisma.refund.update({ where: { id: refundId }, data: { gatewayRefundId: res.id } });
    return { submitted: true, gatewayRefundId: res.id }; // stays PROCESSING until refund.paid arrives
  } catch (err) {
    const msg = err instanceof GatewayError ? `${err.code}: ${err.message}` : String(err.message);
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: msg.slice(0, 300) } });
    log.warn('refund_gateway_error', { refundId, err });
    return { failed: true };
  }
}

/** Scheduler entry: submit approved refunds (event cancellations, automatic refunds, retries after outages). */
export async function processApprovedRefunds(limit = 20) {
  const rows = await prisma.refund.findMany({ where: { status: 'APPROVED' }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true } });
  let n = 0;
  for (const r of rows) { const out = await processRefund(r.id); if (out.submitted) n++; }
  return n;
}

/**
 * Money has verifiably gone back to the customer. Idempotent: the status flip is the gate.
 * @param {{source: 'webhook'|'manual', actor?: object, reference?: string}} meta
 */
export async function completeRefund(refundId, meta = { source: 'webhook' }) {
  const result = await prisma.$transaction(async (tx) => {
    const flipped = await tx.refund.updateMany({ where: { id: refundId, status: { in: ['PROCESSING', 'APPROVED', 'FAILED'] } }, data: { status: 'COMPLETED', completedAt: new Date() } });
    if (flipped.count === 0) return { already: true };
    const refund = await tx.refund.findUnique({ where: { id: refundId }, include: { order: { include: { event: true, tickets: true } } } });
    const order = refund.order;
    const amount = toMinor(refund.amount);
    const record = await tx.commissionRecord.findUnique({ where: { orderId: order.id } });
    const reversal = record
      ? commissionReversal({ orderTotalMinor: toMinor(order.total), commissionMinor: toMinor(record.amount), alreadyReversedMinor: toMinor(record.reversedAmount), refundMinor: amount })
      : 0;
    await postEntries(tx, [
      { organizerId: order.event.organizerId, type: 'REFUND', amount: fromMinor(-amount), currency: order.currency, orderId: order.id, refundId, availableAt: new Date(), idempotencyKey: `refund:${refundId}`, memo: `Refund, order ${order.reference}` },
      ...(reversal > 0 ? [{ organizerId: order.event.organizerId, type: 'COMMISSION_REVERSAL', amount: fromMinor(reversal), currency: order.currency, orderId: order.id, refundId, availableAt: new Date(), idempotencyKey: `refund-commission:${refundId}`, memo: `Commission returned on refund, order ${order.reference}` }] : []),
    ]);
    if (record && reversal > 0) await tx.commissionRecord.update({ where: { id: record.id }, data: { reversedAmount: fromMinor(toMinor(record.reversedAmount) + reversal) } });

    const refundedTotal = toMinor(order.refundedTotal) + amount;
    const fully = refundedTotal >= toMinor(order.total);
    await tx.order.update({ where: { id: order.id }, data: { refundedTotal: fromMinor(refundedTotal), status: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });

    const ids = Array.isArray(refund.ticketIds) ? refund.ticketIds : [];
    await tx.ticket.updateMany({ where: { orderId: order.id, status: { in: ['VALID', 'CANCELLED'] }, ...(ids.length && !refund.isEventCancellation ? { id: { in: ids } } : {}) }, data: { status: 'REFUNDED' } });

    await queueEmail(tx, { to: order.buyerEmail, template: 'refund_status', data: { statusLabel: 'completed', amount: formatMoney(fromMinor(amount), order.currency), reference: order.reference, eventTitle: order.event.title, note: meta.reference ? `Reference: ${meta.reference}` : '' }, dedupeKey: `refund-completed:${refundId}` });
    await audit({ actor: meta.actor ?? null, action: 'refund.complete', entityType: 'Refund', entityId: refundId, eventId: order.eventId, after: { amount: fromMinor(amount), reversal: fromMinor(reversal), source: meta.source, reference: meta.reference ?? null } }, tx);
    return { completed: true };
  });
  kickEmailQueue();
  return result;
}

export async function failRefund(refundId, reason) {
  const r = await prisma.refund.updateMany({ where: { id: refundId, status: { in: ['PROCESSING', 'APPROVED'] } }, data: { status: 'FAILED', failureReason: String(reason).slice(0, 300) } });
  return r.count > 0;
}

export async function listOrderRefundsForAdmin(filters = {}) {
  return prisma.refund.findMany({ where: filters, include: { order: { select: { reference: true, buyerEmail: true, currency: true, event: { select: { title: true } } } } }, orderBy: { createdAt: 'desc' }, take: 200 });
}

export { forbidden };