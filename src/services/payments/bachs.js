// Bachs payment gateway client.
//
// VERIFIED against docs.bachs.io (api-reference/payments/create-checkout-session, checkout-sessions/get-checkout-session,
// refunds/create-refund, guides/webhooks/*) on 2026-10-31:
//   * POST /v1/checkout-sessions   body: { pricing: { currency, amount, price_type: "fixed" }, customer: { email, name, phone_number },
//                                         success_url, cancel_url, metadata (<=20 keys), reference (<=128, unique per account) }
//     NGN minimum amount is 100.00. Money is a decimal string, never minor units. Response: { checkout_id, checkout_url, status, ... }
//   * GET  /v1/checkout-sessions/{checkout_id}   fields: checkout_id, status (open|completed|expired|cancelled), payment_status,
//     amount, currency, reference, charge { payment_id, status, amount, amount_paid, currency, fees: { amount, currency } } (null until a payment is attempted)
//   * POST /v1/refunds   body: { charge_id, reference (required), amount?, reason?, idempotency_key? }  -> { refund_id, status: processing|success|failed }
//   * Webhook signature: HMAC-SHA256 hex over "{timestamp}.{rawBody}", headers X-Bachs-Timestamp / X-Bachs-Signature (or X-Bachs-Signature-V2 "t=..,v1=..")
// STILL UNVERIFIED: the exact charge id that /v1/refunds wants (webhooks show "ch_..." in data.charge_id; the retrieve response shows charge.payment_id).
// We store data.charge_id from the webhook when present and fall back to charge.payment_id.
// If a response lacks an amount or currency the order is NEVER fulfilled automatically; it is parked as NEEDS_REVIEW (fulfilment.js).
import { config } from '../../config/env.js';
import { fromMinor } from '../../lib/money.js';
import { buildCheckoutBody, normalizeCheckout, normalizeRefund } from './bachs-shapes.js';
export { buildCheckoutBody, normalizeCheckout, normalizeRefund };
import { log } from '../../lib/logger.js';

export class GatewayError extends Error {
  constructor(message, { status, code, retryable = false, body } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.body = body;
  }
}

function baseUrl() {
  const key = config.BACHS_API_KEY;
  if (!key) throw new GatewayError('BACHS_API_KEY is not configured', { code: 'not_configured' });
  if (key.startsWith('sk_sandbox_')) return 'https://sandbox-api.bachs.io';
  if (key.startsWith('sk_live_')) {
    if (!config.BACHS_LIVE_ENABLED) throw new GatewayError('Live payments are disabled. Complete the sandbox checklist, then set BACHS_LIVE_ENABLED=true.', { code: 'live_disabled' });
    return 'https://api.bachs.io';
  }
  throw new GatewayError('BACHS_API_KEY must start with sk_sandbox_ or sk_live_', { code: 'bad_key' });
}

async function request(method, path, { body, idempotencyKey, timeoutMs = 20_000 } = {}) {
  const url = baseUrl() + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${config.BACHS_API_KEY}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new GatewayError(err.name === 'AbortError' ? 'Payment provider timed out' : 'Could not reach payment provider', { code: 'network', retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const code = json.error_code || json.code || json.error?.code || `http_${res.status}`;
    const detail = json.detail || json.message || json.error?.message || 'Payment provider rejected the request';
    log.warn('bachs_request_failed', { method, path, status: res.status, errorCode: code, detail: String(detail).slice(0, 300), body: JSON.stringify(json).slice(0, 600), requestId: res.headers.get('x-request-id') });
    throw new GatewayError(detail, { status: res.status, code, retryable: res.status >= 500 || res.status === 429, body: json });
  }
  return json;
}

export const bachsGateway = {
  name: 'bachs',

  async createCheckoutSession(params) {
    const res = await request('POST', config.BACHS_CHECKOUT_PATH, { body: buildCheckoutBody(params), idempotencyKey: params.idempotencyKey });
    const o = res?.data ?? res;
    const checkoutId = o.checkout_id ?? o.id;
    const checkoutUrl = o.checkout_url ?? o.url ?? o.hosted_url;
    if (!checkoutId || !checkoutUrl) throw new GatewayError('Unexpected response from payment provider', { code: 'bad_response', body: res });
    return { checkoutId, checkoutUrl, raw: res };
  },

  /** Authoritative server-to-server lookup. Webhook payloads are never trusted without this. */
  async retrieveCheckout(checkoutId) {
    const path = config.BACHS_VERIFY_PATH.replace('{id}', encodeURIComponent(checkoutId));
    return normalizeCheckout(await request('GET', path));
  },

  async createRefund({ chargeId, amountMinor, reference, reason, idempotencyKey }) {
    const body = { charge_id: chargeId, reference, ...(amountMinor != null ? { amount: fromMinor(amountMinor) } : {}), ...(reason ? { reason } : {}), ...(idempotencyKey ? { idempotency_key: String(idempotencyKey).slice(0, 255) } : {}) };
    return normalizeRefund(await request('POST', config.BACHS_REFUND_PATH, { body, idempotencyKey }));
  },
};