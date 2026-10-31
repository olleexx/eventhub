// Sandbox verification of the Bachs assumptions listed in docs/PAYMENTS.md. Run with a SANDBOX key:
//   BACHS_API_KEY=sk_sandbox_... node scripts/bachs-sandbox-check.js
// It creates ONE checkout session for NGN 100.00, prints the (sanitised) response shape, re-fetches it
// through the verify path, and normalises it exactly like production code does. Nothing is stored.
import { config } from '../src/config/env.js';
import { bachsGateway, buildCheckoutBody, normalizeCheckout } from '../src/services/payments/bachs.js';

if (!config.BACHS_API_KEY?.startsWith('sk_sandbox_')) {
  console.error('Refusing to run: BACHS_API_KEY must be a sk_sandbox_ key.');
  process.exit(1);
}
const shape = (v) => (Array.isArray(v) ? [shape(v[0])] : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
const ref = `CHECK-${Date.now()}`;
const params = { reference: ref, amountMinor: 10000, currency: 'NGN', buyer: { name: 'Sandbox Check', email: 'sandbox-check@example.com' }, successUrl: `${config.APP_URL}/orders/${ref}`, cancelUrl: `${config.APP_URL}/`, metadata: { order_reference: ref }, description: 'Sandbox check', idempotencyKey: `check:${ref}` };
console.log('Request body we send:', JSON.stringify(buildCheckoutBody(params), null, 2));
try {
  const s = await bachsGateway.createCheckoutSession(params);
  console.log('\nCREATE ok. Response shape:', JSON.stringify(shape(s.raw), null, 2));
  console.log('checkoutId:', s.checkoutId, '\nOpen this URL and pay with a sandbox test method:', s.checkoutUrl);
  const v = await bachsGateway.retrieveCheckout(s.checkoutId);
  console.log('\nVERIFY ok. Raw shape:', JSON.stringify(shape(v.raw), null, 2));
  console.log('Normalised:', { ...v, raw: undefined });
  const missing = ['id', 'status', 'amountMinor', 'currency'].filter((k) => v[k] == null || v[k] === '');
  if (missing.length) console.warn(`\n!! Normaliser could not read: ${missing.join(', ')}. Adjust normalizeCheckout() in src/services/payments/bachs.js to the real field names.`);
  else console.log('\nAll required fields were readable. Now pay the session, then re-run verification to see status "succeeded" and the exact amount.');
} catch (err) {
  console.error('\nFAILED:', err.status, err.code, err.message, JSON.stringify(err.body ?? {}, null, 2));
  console.error('Fix BUILD body / paths (BACHS_CHECKOUT_PATH, BACHS_VERIFY_PATH) per docs.bachs.io, then retry.');
  process.exitCode = 1;
}
