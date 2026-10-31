# Operations

## Background jobs (`src/jobs/tasks.js`)
| Task | Every | Purpose |
|---|---|---|
| expire-orders | 1 min | release holds on unpaid orders |
| publish-scheduled | 1 min | publish events at their scheduled time |
| emails | 30 s | send queued email (outbox, exponential backoff) |
| process-refunds | 1 min | submit approved refunds to the gateway |
| reconcile | 5 min | re-check PENDING payments with the gateway |
| retry-webhooks | 5 min | re-process FAILED webhook events |
| waitlists | 5 min | notify waitlisted people when stock frees up |
| reminders | 30 min | event reminder emails |
| housekeeping | 6 h | purge expired sessions etc. |
External trigger: `POST /internal/cron/<task|all>` with `Authorization: Bearer $CRON_SECRET`.

## Runbooks
**Customer paid but has no tickets.** `/admin#/orders` → inspect the order. Status `NEEDS_REVIEW` shows the reason. Use *Re-check payment* (server-side gateway lookup). If the gateway shows success but amount/currency differ, do not force it: refund or contact Bachs. `/admin#/reconciliation` lists paid-without-tickets and succeeded-but-unpaid cases.

**Webhooks failing.** `/admin#/system` shows webhook status counts. Verify `BACHS_WEBHOOK_SECRET`; check the signature scheme (docs/PAYMENTS.md). FAILED events are retried by the job.

**Refund stuck in PROCESSING.** The provider has not confirmed. Check Bachs; use *Retry*, or after confirming in Bachs use *Mark complete…* with the provider reference (audited).

**Payout.** Admin → Payouts: approve, make the bank transfer, then *Mark paid* with the bank reference.

**Oversell suspicion.** DB CHECK constraints make `sold + reserved > total` impossible; reconciliation reports counter/hold mismatches.

**Email not arriving.** `/admin#/system`: send a test, view the log, *Retry failed*. Check SPF/DKIM/DMARC.

## Monitoring (not built in)
Logs are structured JSON on stdout. Add uptime checks on `/readyz`, alert on 5xx rate, FAILED webhooks, failed emails and NEEDS_REVIEW orders.
