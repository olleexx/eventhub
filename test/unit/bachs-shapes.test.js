// Fixtures are copied from the shapes documented at docs.bachs.io (create-checkout-session, get-checkout-session, refunds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckoutBody, normalizeCheckout, normalizeRefund } from '../../src/services/payments/bachs-shapes.js';

test('create-checkout body uses the documented product-less "pricing" object', () => {
  const b = buildCheckoutBody({ reference: 'EH-1', amountMinor: 500000, currency: 'NGN', buyer: { name: 'Bola', email: 'b@e.st', phone: '+2348000000000' }, successUrl: 'https://x/ok', cancelUrl: 'https://x/no', metadata: { order_reference: 'EH-1' } });
  assert.deepEqual(b.pricing, { currency: 'NGN', amount: '5000.00', price_type: 'fixed' });
  assert.deepEqual(b.customer, { email: 'b@e.st', name: 'Bola', phone_number: '+2348000000000' });
  assert.equal(b.reference, 'EH-1');
  for (const forbidden of ['amount', 'currency', 'description']) assert.equal(forbidden in b, false, `${forbidden} is not a top-level field`);
});

test('open checkout (no charge yet) is pending', () => {
  const n = normalizeCheckout({ checkout_id: 'chk_1', status: 'open', payment_status: 'requires_payment_method', amount: '5000.00', currency: 'NGN', reference: 'EH-1', charge: null });
  assert.equal(n.status, 'pending'); assert.equal(n.id, 'chk_1'); assert.equal(n.chargeId, null);
});

test('paid checkout: amount_paid, currency, charge id and same-currency fee are read', () => {
  const n = normalizeCheckout({ checkout_id: 'chk_1', status: 'completed', payment_status: 'succeeded', amount: '5000.00', currency: 'NGN', charge: { payment_id: 'pay_9', status: 'succeeded', amount: '5000.00', amount_paid: '5000.00', currency: 'NGN', fees: { amount: '75.00', currency: 'NGN' } } });
  assert.equal(n.status, 'succeeded'); assert.equal(n.amountMinor, 500000); assert.equal(n.currency, 'NGN'); assert.equal(n.feeMinor, 7500); assert.equal(n.chargeId, 'pay_9');
});

test('underpaid / overpaid are never treated as paid (parked for review)', () => {
  for (const st of ['underpaid', 'overpaid', 'accepted']) assert.equal(normalizeCheckout({ checkout_id: 'c', status: 'open', amount: '5000.00', currency: 'NGN', charge: { status: st, amount: '5000.00', amount_paid: '100.00', currency: 'NGN' } }).status, 'underpaid');
});

test('failed charge and expired session map correctly; unknown shapes stay pending', () => {
  assert.equal(normalizeCheckout({ checkout_id: 'c', status: 'open', charge: { status: 'failed', currency: 'NGN' } }).status, 'failed');
  assert.equal(normalizeCheckout({ checkout_id: 'c', status: 'expired', charge: null }).status, 'expired');
  assert.equal(normalizeCheckout({}).status, 'pending');
  assert.equal(normalizeCheckout({ checkout_id: 'c', status: 'completed' }).status, 'pending', 'a "completed" session alone is not proof of payment');
});

test('a paid response without amount/currency yields nulls so fulfilment parks it for review', () => {
  const n = normalizeCheckout({ checkout_id: 'c', payment_status: 'succeeded' });
  assert.equal(n.status, 'succeeded'); assert.equal(n.amountMinor, null); assert.equal(n.currency, null);
});

test('refund response', () => {
  assert.deepEqual({ ...normalizeRefund({ refund_id: 'ref_1', status: 'processing' }), raw: undefined }, { id: 'ref_1', status: 'processing', raw: undefined });
});