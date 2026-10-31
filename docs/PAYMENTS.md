# Payments (Bachs)

## Architecture
The app talks to one interface (`src/services/payments/index.js`): `createCheckoutSession`, `retrieveCheckout`, `createRefund`. `bachs.js` implements it; `mock.js` implements it in memory **for tests only** and is refused when `NODE_ENV=production`.

Rules the code enforces:
1. **Redirects and webhooks never mark money as received.** On a `collection.succeeded` webhook, or when the customer returns to the order page, the server calls the Bachs API (`retrieveCheckout`) and fulfils only if the gateway reports a successful status **and** the amount and currency equal the order total.
2. If the response has no amount or currency (e.g. an assumed field name is wrong), the order goes to `NEEDS_REVIEW`; it is never fulfilled blindly.
3. Webhooks: signature verified over the raw body with a timestamp tolerance; every event stored once (unique `provider+eventId`), duplicates acknowledged; failures return 5xx so Bachs retries; a job re-processes FAILED events.
4. Inventory is reserved atomically at checkout (default 15 min) and released on expiry/failure. A payment that arrives after expiry either reclaims capacity or, if sold out, the order is parked and auto-refunded.
5. Refunds complete only on a signed `refund.paid` event (or an audited manual completion that requires a provider reference).

## What is confirmed vs. unverified
docs.bachs.io was **unreachable** while this was written. From vendor SDK pages and third-party integrations the code assumes (and states in `bachs.js`):

Confirmed-ish: Bearer auth; `sk_sandbox_` → `https://sandbox-api.bachs.io`, `sk_live_` → `https://api.bachs.io`; decimal-string money; `Idempotency-Key`; refund body `{ charge_id, reference }`; ID prefixes; event names `collection.succeeded|failed|underpaid`, `checkout.expired`, `refund.created|paid|failed`.

**UNVERIFIED (must be checked against the official docs):**
| Item | Where | Override |
|---|---|---|
| Create-checkout request body for a raw amount (not a product cart) | `buildCheckoutBody()` | edit function |
| Create-checkout path | `BACHS_CHECKOUT_PATH` | env |
| Verify/retrieve path and response field names (status, amount, currency, fee) | `normalizeCheckout()` | `BACHS_VERIFY_PATH`, edit function |
| Refund path and response shape | `normalizeRefund()` | `BACHS_REFUND_PATH` |
| **Webhook signature scheme** (header names `x-bachs-signature` / `x-bachs-timestamp`, HMAC-SHA256 over `timestamp.body`, hex) | `webhook-signature.js` | edit file; unit tests in `test/unit/webhook-signature.test.js` |

If the signature scheme is wrong, **every real webhook will be rejected (401)**; that fails closed. Orders will still complete through the return-page verification and the reconcile job, but fix the scheme.

## Sandbox procedure (do before live)
1. Set a `sk_sandbox_…` key and webhook secret. Run `npm run bachs:check`: it creates a sandbox checkout and prints the raw response so you can compare field names.
2. Fix any mismatch in `bachs.js` / `webhook-signature.js`; update the unit tests.
3. In the sandbox, test: successful payment, abandoned payment (expiry), failed payment, underpayment (if simulable), duplicate webhook delivery, refund end-to-end.
4. Check `/admin#/orders` and `/admin#/reconciliation` show no discrepancies.
5. Only then use a `sk_live_` key **and** set `BACHS_LIVE_ENABLED=true`. Without that flag the app refuses live mode.

## Go-live checklist
- [ ] Sandbox flows above all pass
- [ ] Webhook URL is HTTPS and registered with the live signing secret
- [ ] `APP_URL` is the public https URL (used for return links and CSRF origin checks)
- [ ] SMTP works (`/admin#/system` → send test email)
- [ ] Cron/worker running (see OPERATIONS.md)
- [ ] Legal pages reviewed by counsel; commission rate agreed
