// Checkout: validate -> price (server side only) -> reserve inventory -> create PENDING order ->
// open a hosted payment session. The browser never supplies a price, total, commission or status.
//
// PRICING POLICY FOR PENDING CHECKOUTS: unit prices are snapshotted on OrderItem when the order is
// created. A later organizer price change affects only NEW orders; an order awaiting payment is
// honoured at its snapshotted price until its reservation expires (settings.reservationMinutes),
// after which the buyer starts again at the current price. The commission rate is snapshotted too.
import { prisma, Prisma } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, badGateway } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { toMinor, fromMinor, divRound } from '../lib/money.js';
import { calculateCommission, effectiveRates } from './commission.js';
import { orderReference, orderAccessToken, sha256 } from '../utils/crypto.js';
import { getSettings } from './settings.js';
import { reserveItems, releaseOrderInventory, recalcEventStats } from './inventory.js';
import { ticketAvailability } from './events.js';
import { getGateway, GatewayError } from './payments/index.js';
import { audit } from './audit.js';

const ACTIVE_ORDER_STATUSES = ['PENDING', 'PAID', 'PARTIALLY_REFUNDED'];

/** Pro-rata allocation of an order-level discount across lines (last line takes the remainder). */
export function allocateDiscount(grossLines, discountMinor) {
  const total = grossLines.reduce((a, b) => a + b, 0);
  if (discountMinor <= 0 || total <= 0) return grossLines.map(() => 0);
  let left = discountMinor;
  return grossLines.map((g, i) => {
    if (i === grossLines.length - 1) return left;
    const share = Math.min(left, divRound(discountMinor * g, total));
    left -= share;
    return share;
  });
}

async function resolveDiscount(tx, event, code, subtotalMinor) {
  if (!code) return { discountMinor: 0, discountCodeId: null };
  const settings = await getSettings();
  if (!settings.featureDiscountCodes) throw badRequest('Discount codes are not available', undefined, 'DISCOUNT_DISABLED');
  const d = await tx.discountCode.findUnique({ where: { eventId_code: { eventId: event.id, code: String(code).trim().toUpperCase() } } });
  if (!d || !d.active || (d.expiresAt && d.expiresAt < new Date())) throw badRequest('That discount code is not valid', [{ path: 'discountCode', message: 'Invalid or expired code' }], 'DISCOUNT_INVALID');
  // Atomic claim: respects maxUses under concurrency.
  const claimed = await tx.$executeRaw(Prisma.sql`
    UPDATE "DiscountCode" SET "usedCount" = "usedCount" + 1
     WHERE "id" = ${d.id} AND "active" = true AND ("maxUses" IS NULL OR "usedCount" < "maxUses") AND ("expiresAt" IS NULL OR "expiresAt" > now())`);
  if (claimed === 0) throw badRequest('That discount code has been fully used', [{ path: 'discountCode', message: 'Code fully used' }], 'DISCOUNT_EXHAUSTED');
  let off = 0;
  if (d.percentOff) off = divRound(subtotalMinor * Math.round(Number(d.percentOff.toString()) * 100), 10000);
  else if (d.amountOff) off = toMinor(d.amountOff);
  return { discountMinor: Math.min(off, subtotalMinor), discountCodeId: d.id };
}

export async function previewDiscount({ eventId, code, items }) {
  const event = await prisma.event.findFirst({ where: { id: eventId, status: 'PUBLISHED' } });
  if (!event) throw notFound('Event not found');
  const d = await prisma.discountCode.findUnique({ where: { eventId_code: { eventId, code: String(code).trim().toUpperCase() } } });
  if (!d || !d.active || (d.expiresAt && d.expiresAt < new Date()) || (d.maxUses && d.usedCount >= d.maxUses)) return { valid: false };
  const types = await prisma.ticketType.findMany({ where: { eventId, id: { in: items.map((i) => i.ticketTypeId) } } });
  const subtotal = items.reduce((s, i) => s + toMinor(types.find((t) => t.id === i.ticketTypeId)?.price ?? 0) * i.quantity, 0);
  const off = d.percentOff ? divRound(subtotal * Math.round(Number(d.percentOff.toString()) * 100), 10000) : d.amountOff ? Math.min(toMinor(d.amountOff), subtotal) : 0;
  return { valid: true, discount: fromMinor(off), total: fromMinor(subtotal - off) };
}

function mergeItems(items) {
  const m = new Map();
  for (const i of items) m.set(i.ticketTypeId, (m.get(i.ticketTypeId) ?? 0) + i.quantity);
  return [...m].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
}

export async function createCheckout({ user, input, ip }) {
  const settings = await getSettings();
  if (settings.maintenanceMode) throw new AppError(503, 'MAINTENANCE', 'Ticket sales are paused for maintenance. Please try again shortly.');
  if (!user && !settings.guestCheckout) throw unauthorized('Please sign in to buy tickets', 'LOGIN_REQUIRED');

  const event = await prisma.event.findFirst({
    where: { id: input.eventId, status: 'PUBLISHED', endsAt: { gte: new Date() }, organizer: { suspended: false, user: { status: 'ACTIVE' } } },
  });
  if (!event) throw notFound('This event is not on sale');

  const items = mergeItems(input.items);
  const types = await prisma.ticketType.findMany({ where: { eventId: event.id, id: { in: items.map((i) => i.ticketTypeId) } } });
  const now = new Date();
  const buyerEmail = (user?.email ?? input.buyer.email).toLowerCase();
  const lines = [];
  let ticketCount = 0;
  for (const it of items) {
    const t = types.find((x) => x.id === it.ticketTypeId);
    if (!t || !t.active || !t.visible) throw badRequest('One of the selected tickets is no longer available', [{ path: 'items', message: 'Ticket unavailable' }], 'TICKET_UNAVAILABLE');
    const av = ticketAvailability(t, now);
    if (av.state === 'NOT_STARTED') throw conflict(`Sales for "${t.name}" have not started yet`, 'SALES_NOT_STARTED');
    if (av.state === 'ENDED') throw conflict(`Sales for "${t.name}" have closed`, 'SALES_ENDED');
    if (av.state === 'SOLD_OUT') throw conflict(`"${t.name}" is sold out`, 'SOLD_OUT', { ticketTypeId: t.id });
    const maxPer = Math.min(t.maxPerOrder, settings.maxTicketsPerOrder);
    if (it.quantity < t.minPerOrder) throw badRequest(`Minimum ${t.minPerOrder} for "${t.name}"`, [{ path: 'items', message: 'Below minimum' }], 'BELOW_MINIMUM');
    if (it.quantity > maxPer) throw badRequest(`Maximum ${maxPer} per order for "${t.name}"`, [{ path: 'items', message: 'Above maximum' }], 'ABOVE_MAXIMUM');
    if (t.perCustomerLimit) {
      const held = await prisma.orderItem.aggregate({
        _sum: { quantity: true },
        where: { ticketTypeId: t.id, order: { status: { in: ACTIVE_ORDER_STATUSES }, OR: [{ buyerEmail }, ...(user ? [{ userId: user.id }] : [])] } },
      });
      if ((held._sum.quantity ?? 0) + it.quantity > t.perCustomerLimit) throw conflict(`Limit of ${t.perCustomerLimit} per customer for "${t.name}"`, 'PER_CUSTOMER_LIMIT');
    }
    ticketCount += it.quantity;
    lines.push({ type: t, quantity: it.quantity, unitMinor: toMinor(t.price) });
  }

  // Custom registration questions and attendee details.
  const questions = Array.isArray(event.customQuestions) ? event.customQuestions : [];
  const attendees = input.attendees ?? [];
  if (attendees.length && attendees.length !== ticketCount) throw badRequest('Provide details for every ticket or none', [{ path: 'attendees', message: `Expected ${ticketCount}` }]);
  const answerSets = attendees.length ? attendees.map((a) => a.answers ?? {}) : [input.answers ?? {}];
  for (const q of questions.filter((x) => x.required)) {
    if (answerSets.some((a) => !a[q.id] || String(a[q.id]).trim() === '')) throw badRequest(`Please answer: ${q.label}`, [{ path: `answers.${q.id}`, message: 'Required' }], 'ANSWER_REQUIRED');
  }

  const reference = orderReference();
  const accessToken = orderAccessToken(reference, config.SESSION_SECRET);
  const subtotalMinor = lines.reduce((s, l) => s + l.unitMinor * l.quantity, 0);

  const order = await prisma.$transaction(async (tx) => {
    await reserveItems(tx, lines.map((l) => ({ ticketTypeId: l.type.id, quantity: l.quantity, name: l.type.name })));
    const { discountMinor, discountCodeId } = await resolveDiscount(tx, event, input.discountCode, subtotalMinor);
    const discounts = allocateDiscount(lines.map((l) => l.unitMinor * l.quantity), discountMinor);
    const rates = effectiveRates(settings.allowEventCommissionOverride ? event : { ...event, commissionOverridePercent: null, commissionOverrideFixed: null }, settings);
    const comm = calculateCommission({ lines: lines.map((l, i) => ({ unitMinor: l.unitMinor, quantity: l.quantity, discountMinor: discounts[i] })), percent: rates.percent, fixedMinorPerTicket: rates.fixedMinorPerTicket });
    const totalMinor = subtotalMinor - discountMinor;

    const created = await tx.order.create({
      data: {
        reference, userId: user?.id ?? null,
        buyerName: input.buyer?.name ?? user.name, buyerEmail, buyerPhone: input.buyer?.phone ?? user?.phone ?? null,
        accessTokenHash: sha256(accessToken), eventId: event.id, status: 'PENDING', currency: event.currency,
        subtotal: fromMinor(subtotalMinor), discountTotal: fromMinor(discountMinor), total: fromMinor(totalMinor),
        commissionTotal: fromMinor(comm.total), commissionPercentApplied: String(rates.percent), commissionFixedApplied: fromMinor(rates.fixedMinorPerTicket),
        organizerNet: fromMinor(totalMinor - comm.total),
        discountCodeId, referralSource: input.referralSource ?? null,
        attendeeInfo: attendees.length ? attendees : input.answers ? [{ answers: input.answers }] : [],
        reservedUntil: new Date(Date.now() + settings.reservationMinutes * 60_000),
        items: {
          create: lines.map((l, i) => ({
            ticketTypeId: l.type.id, quantity: l.quantity, unitPrice: fromMinor(l.unitMinor), discount: fromMinor(discounts[i]),
            lineTotal: fromMinor(l.unitMinor * l.quantity - discounts[i]), commission: fromMinor(comm.lines[i].commission),
          })),
        },
      },
      include: { items: true },
    });
    await recalcEventStats(tx, event.id);
    return created;
  });

  // Free order: no gateway involved; issue tickets immediately.
  if (toMinor(order.total) === 0) {
    const { fulfilFreeOrder } = await import('./fulfilment.js');
    await fulfilFreeOrder(order.id);
    return { reference, accessToken: user ? null : accessToken, free: true, expiresAt: null, checkoutUrl: null };
  }

  // Paid order: create the hosted checkout OUTSIDE the DB transaction (no locks held over the network).
  const gateway = getGateway();
  const payment = await prisma.payment.create({
    data: { orderId: order.id, provider: gateway.name, status: 'INITIATED', amount: order.total, currency: order.currency, idempotencyKey: `order:${reference}` },
  });
  try {
    const base = config.APP_URL.replace(/\/$/, '');
    const session = await gateway.createCheckoutSession({
      reference, amountMinor: toMinor(order.total), currency: order.currency,
      buyer: { name: order.buyerName, email: order.buyerEmail, phone: order.buyerPhone },
      successUrl: `${base}/orders/${reference}`, // Bachs appends ?checkout_id=...; the guest token travels in sessionStorage and the emailed link
      cancelUrl: `${base}/e/${event.slug}?cancelled=1`,
      metadata: { order_reference: reference, order_id: order.id, event_id: event.id, platform: 'eventhub' },
      description: `${event.title} (${ticketCount} ticket${ticketCount === 1 ? '' : 's'})`.slice(0, 120),
      idempotencyKey: payment.idempotencyKey,
    });
    await prisma.payment.update({ where: { id: payment.id }, data: { gatewayCheckoutId: session.checkoutId, checkoutUrl: session.checkoutUrl, status: 'PENDING' } });
    return { reference, accessToken: user ? null : accessToken, free: false, checkoutUrl: session.checkoutUrl, expiresAt: order.reservedUntil };
  } catch (err) {
    log.error('checkout_session_failed', { reference, err });
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: `${err.code ?? ''}${err.status ? ` HTTP ${err.status}` : ''}: ${String(err.message)}`.slice(0, 300) } });
    await cancelPendingOrder(order.id, 'FAILED', 'gateway_unavailable');
    if (err instanceof GatewayError && ['not_configured', 'live_disabled', 'bad_key'].includes(err.code)) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not available right now. Please try again later.');
    // In development, show the provider's reason so setup problems are visible; production keeps the generic text.
    const why = !config.isProd && err instanceof GatewayError ? ` [dev detail: ${err.code ?? 'error'}${err.status ? ` HTTP ${err.status}` : ''}: ${String(err.message).slice(0, 200)}]` : '';
    throw badGateway(`We could not start your payment. You have not been charged. Please try again.${why}`);
  }
}

/**
 * Move a PENDING order to a terminal non-paid state and release its inventory, exactly once.
 * Safe to call repeatedly and concurrently (conditional update is the gate).
 */
export async function cancelPendingOrder(orderId, status = 'EXPIRED', reason = null) {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.order.updateMany({ where: { id: orderId, status: 'PENDING' }, data: { status, reviewNote: reason } });
    if (moved.count === 0) return false;
    await releaseOrderInventory(tx, orderId);
    await tx.payment.updateMany({ where: { orderId, status: { in: ['INITIATED', 'PENDING'] } }, data: { status: status === 'EXPIRED' ? 'EXPIRED' : 'FAILED' } });
    return true;
  });
}

/** Customer-facing order status (used by the post-payment polling page). */
export async function orderStatusSummary(order) {
  return {
    reference: order.reference, status: order.status, total: order.total.toString(), currency: order.currency,
    ticketCount: order.tickets?.length ?? 0, reservedUntil: order.reservedUntil, needsReview: order.status === 'NEEDS_REVIEW',
  };
}

export { forbidden };