// Bachs webhook ingestion.
//   1. Verify the signature over the RAW body (fails closed).
//   2. Record the event (unique per provider+eventId) => duplicate deliveries are acknowledged, not re-run.
//   3. NEVER trust the payload for money: re-fetch the checkout from the Bachs API and fulfil from that.
//   4. On processing errors respond 5xx so Bachs retries; the event row is marked FAILED and is
//      reprocessed on the next delivery (processing is idempotent).
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { sha256 } from '../utils/crypto.js';
import { verifyWebhookSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './payments/webhook-signature.js';
import { getGateway, webhookSecrets } from './payments/index.js';
import { applyVerifiedPayment } from './fulfilment.js';
import { cancelPendingOrder } from './checkout.js';
import { completeRefund, failRefund } from './refunds.js';
import { queueEmail, kickEmailQueue } from './email.js';

function extract(data) {
  const o = data?.object ?? data ?? {};
  return { id: o.refund_id ?? o.id ?? null, chargeId: o.charge_id ?? null, checkoutId: o.checkout_id ?? o.checkout?.id ?? o.charge_id ?? o.id ?? null, reference: o.reference ?? o.metadata?.order_reference ?? null, raw: o };
}

async function findPayment({ checkoutId, reference }) {
  let payment = checkoutId ? await prisma.payment.findUnique({ where: { gatewayCheckoutId: checkoutId } }) : null;
  if (!payment && reference) {
    const order = await prisma.order.findUnique({ where: { reference }, include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    payment = order?.payments[0] ?? null;
    if (payment && checkoutId && !payment.gatewayCheckoutId) {
      payment = await prisma.payment.update({ where: { id: payment.id }, data: { gatewayCheckoutId: checkoutId } });
    }
  }
  return payment;
}

async function onCollection(type, data) {
  const ex = extract(data);
  const payment = await findPayment(ex);
  if (!payment) throw new Error(`No payment found for checkout ${ex.checkoutId} / reference ${ex.reference}`); // => 5xx => provider retries later

  if (type === 'collection.succeeded') {
    const verified = await getGateway().retrieveCheckout(payment.gatewayCheckoutId ?? ex.checkoutId);
    const out = await applyVerifiedPayment({ paymentId: payment.id, verified: { ...verified, chargeId: ex.chargeId ?? verified.chargeId ?? null }, source: 'webhook' });
    return { note: out.outcome };
  }

  if (payment.status === 'SUCCEEDED') return { note: 'ignored_already_succeeded' }; // never downgrade
  const order = await prisma.order.findUnique({ where: { id: payment.orderId }, include: { event: true } });

  if (type === 'collection.failed') {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', lastGatewayStatus: 'failed', failureReason: String(ex.raw.failure_reason ?? ex.raw.reason ?? 'payment failed').slice(0, 300) } });
    if (order.status === 'PENDING') {
      await queueEmail(prisma, { to: order.buyerEmail, template: 'payment_failed', data: { reference: order.reference, eventTitle: order.event.title, eventSlug: order.event.slug, reason: '' }, dedupeKey: `payment-failed:${order.id}` });
      kickEmailQueue();
    }
    return { note: 'payment_failed' };
  }
  if (type === 'collection.underpaid') {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'UNDERPAID', lastGatewayStatus: 'underpaid' } });
    if (order.status === 'PENDING') await prisma.order.update({ where: { id: order.id }, data: { status: 'NEEDS_REVIEW', reviewNote: 'underpaid' } });
    return { note: 'underpaid_needs_review' };
  }
  if (type === 'checkout.expired') {
    await cancelPendingOrder(order.id, 'EXPIRED', 'checkout_expired');
    return { note: 'expired' };
  }
  return { note: 'ignored' };
}

async function onRefund(type, data) {
  const ex = extract(data);
  const refund = (ex.reference && (await prisma.refund.findUnique({ where: { id: ex.reference } }))) || (ex.id && (await prisma.refund.findFirst({ where: { gatewayRefundId: ex.id } })));
  if (!refund) throw new Error(`No refund found for ${ex.id} / ${ex.reference}`);
  if (type === 'refund.paid') { await completeRefund(refund.id, { source: 'webhook', reference: ex.id }); return { note: 'refund_completed' }; }
  if (type === 'refund.failed') { await failRefund(refund.id, ex.raw.failure_reason ?? 'gateway reported refund failure'); return { note: 'refund_failed' }; }
  if (!refund.gatewayRefundId && ex.id) await prisma.refund.update({ where: { id: refund.id }, data: { gatewayRefundId: ex.id } });
  return { note: 'refund_created' };
}

export async function handleBachsWebhook({ rawBody, headers }) {
  // Prefer the V2 header ("t=<ts>,v1=<sig>[,v1=<sig>]"), fall back to X-Bachs-Signature + X-Bachs-Timestamp.
  const v2 = headers['x-bachs-signature-v2'];
  const v2ts = typeof v2 === 'string' ? /(?:^|,)\s*t=(\d+)/.exec(v2)?.[1] : undefined;
  const check = verifyWebhookSignature({ rawBody, signature: v2 || headers[SIGNATURE_HEADER], timestamp: headers[TIMESTAMP_HEADER] || v2ts, secrets: webhookSecrets() });
  if (!check.ok) {
    log.warn('webhook_rejected', { reason: check.reason });
    throw new AppError(401, 'BAD_SIGNATURE', 'Invalid webhook signature');
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new AppError(400, 'BAD_JSON', 'Malformed payload'); }
  const payloadHash = sha256(rawBody);
  const eventId = String(event.id ?? `hash_${payloadHash}`);
  const type = String(event.type ?? event.event ?? 'unknown');

  await prisma.paymentWebhookEvent.createMany({ data: [{ provider: 'bachs', eventId, type, payloadHash, payload: event }], skipDuplicates: true });
  const row = await prisma.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider: 'bachs', eventId } } });
  if (['PROCESSED', 'IGNORED'].includes(row.status)) return { duplicate: true };

  return processStoredWebhook(row);
}

/** Process (or re-process) a persisted webhook event. Idempotent; used by the HTTP handler and the retry job. */
export async function processStoredWebhook(row) {
  const event = row.payload;
  const type = row.type;
  await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
  try {
    let result;
    const data = event.data ?? event;
    if (type.startsWith('collection.') || type === 'checkout.expired') result = await onCollection(type, data);
    else if (type.startsWith('refund.')) result = await onRefund(type, data);
    else result = { note: 'ignored_type' };
    await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: result.note?.startsWith('ignored') ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), error: null } });
    return { duplicate: false, result };
  } catch (err) {
    await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: String(err.message).slice(0, 500) } });
    log.error('webhook_processing_failed', { eventId: row.eventId, type, err });
    throw err;
  }
}