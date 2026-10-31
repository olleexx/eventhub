// In-memory gateway used ONLY by automated tests (PAYMENTS_DRIVER=mock is rejected in production
// by config/env.js). It implements the same interface as bachs.js so the checkout, webhook,
// fulfilment and refund code paths are exercised without network access.
import { GatewayError } from './bachs.js';

let seq = 0;
const checkouts = new Map();
const refunds = new Map();

export const mockGateway = {
  name: 'mock',

  async createCheckoutSession({ reference, amountMinor, currency, idempotencyKey }) {
    if (mockGateway.failNextCreate) { mockGateway.failNextCreate = false; throw new GatewayError('mock failure', { code: 'network', retryable: true }); }
    const existing = [...checkouts.values()].find((c) => c.idempotencyKey === idempotencyKey);
    if (existing) return { checkoutId: existing.id, checkoutUrl: existing.url, raw: {} };
    const id = `chk_mock_${++seq}`;
    const rec = { id, idempotencyKey, reference, amountMinor, currency, status: 'pending', url: `https://checkout.mock.invalid/${id}` };
    checkouts.set(id, rec);
    return { checkoutId: id, checkoutUrl: rec.url, raw: {} };
  },

  async retrieveCheckout(id) {
    const c = checkouts.get(id);
    if (!c) throw new GatewayError('not found', { status: 404, code: 'not_found' });
    return { id, chargeId: id, status: c.status, rawStatus: c.status, amountMinor: c.paidMinor ?? c.amountMinor, currency: c.currency, feeMinor: c.feeMinor ?? null, reference: c.reference, raw: {} };
  },

  async createRefund({ chargeId, amountMinor, reference, idempotencyKey }) {
    if (mockGateway.failNextRefund) { mockGateway.failNextRefund = false; throw new GatewayError('mock refund failure', { code: 'http_500', retryable: true }); }
    const existing = [...refunds.values()].find((r) => r.idempotencyKey === idempotencyKey);
    if (existing) return { id: existing.id, status: 'pending', raw: {} };
    const id = `ref_mock_${++seq}`;
    refunds.set(id, { id, chargeId, amountMinor, reference, idempotencyKey });
    return { id, status: 'pending', raw: {} };
  },

  // ---- test helpers ----
  failNextCreate: false,
  failNextRefund: false,
  setCheckout(id, patch) { Object.assign(checkouts.get(id), patch); },
  getCheckout(id) { return checkouts.get(id); },
  refundCount() { return refunds.size; },
  reset() { checkouts.clear(); refunds.clear(); seq = 0; mockGateway.failNextCreate = false; mockGateway.failNextRefund = false; },
};
