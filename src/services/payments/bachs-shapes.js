// Pure request/response shaping for Bachs (no config, no network) so it can be unit-tested with the documented payloads.
import { fromMinor, toMinor } from '../../lib/money.js';

export function buildCheckoutBody({ reference, amountMinor, currency, buyer, successUrl, cancelUrl, metadata }) {
  return {
    pricing: { currency, amount: fromMinor(amountMinor), price_type: 'fixed' },
    customer: { email: buyer.email, name: buyer.name, ...(buyer.phone ? { phone_number: buyer.phone } : {}) },
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    reference,
  };
}

// Charge-level statuses (lowercase on the retrieve endpoint).
const PAID_CHARGE = new Set(['succeeded']);
const REVIEW_CHARGE = new Set(['underpaid', 'overpaid', 'accepted', 'partially_refunded', 'auto_refunded']);
const FAILED_CHARGE = new Set(['failed', 'cancelled', 'canceled']);

export function normalizeCheckout(raw) {
  const o = raw?.data ?? raw ?? {};
  const charge = o.charge ?? null;
  const sessionStatus = String(o.status ?? '').toLowerCase();
  const chargeStatus = String(charge?.status ?? o.payment_status ?? '').toLowerCase();
  let status = 'pending';
  if (PAID_CHARGE.has(chargeStatus) || String(o.payment_status ?? '').toLowerCase() === 'succeeded') status = 'succeeded';
  else if (REVIEW_CHARGE.has(chargeStatus)) status = 'underpaid'; // parked for manual review, never auto-fulfilled
  else if (FAILED_CHARGE.has(chargeStatus)) status = 'failed';
  else if (sessionStatus === 'expired' || sessionStatus === 'cancelled') status = 'expired';
  const amount = charge?.amount_paid ?? charge?.amount ?? o.amount ?? null;
  const fee = charge?.fees?.currency && o.currency && String(charge.fees.currency).toUpperCase() === String(charge.currency ?? o.currency).toUpperCase() ? charge.fees.amount : null;
  let amountMinor = null;
  let feeMinor = null;
  try { if (amount !== null && amount !== undefined) amountMinor = toMinor(String(amount)); } catch { amountMinor = null; }
  try { if (fee !== null && fee !== undefined) feeMinor = toMinor(String(fee)); } catch { feeMinor = null; }
  return {
    id: o.checkout_id ?? o.id ?? null,
    chargeId: charge?.payment_id ?? charge?.id ?? null,
    status,
    rawStatus: `${sessionStatus}/${chargeStatus}`,
    amountMinor,
    currency: (charge?.currency ?? o.currency) ? String(charge?.currency ?? o.currency).toUpperCase() : null,
    feeMinor,
    reference: o.reference ?? o.metadata?.order_reference ?? null,
    raw,
  };
}

export function normalizeRefund(raw) {
  const o = raw?.data ?? raw ?? {};
  return { id: o.refund_id ?? o.id ?? null, status: String(o.status ?? '').toLowerCase(), raw };
}