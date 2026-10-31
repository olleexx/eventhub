# Owambe Ticketing (EventHub)

Multi-vendor event ticketing and management: free event creation, paid ticket sales through **Bachs**, QR tickets and check-in, organizer analytics, an admin console, refunds, a commission ledger and manual payouts.

Node.js (ES modules) · Express 4 · PostgreSQL via Prisma · vanilla HTML/CSS/JS frontend (no framework) · Nodemailer · QR + PDF tickets.

> ## Read this first: what has and has not been verified
> This codebase was written in a sandbox with **no access to the npm registry, no PostgreSQL, and no access to docs.bachs.io**. So:
>
> | Verified (actually executed) | NOT verified |
> |---|---|
> | `node scripts/syntax-check.js` (98 files, 0 syntax errors) | `npm install` / `prisma generate` / any migration |
> | `node scripts/import-check.js` (every relative import and named export resolves) | The server starting; any HTTP route; any SQL |
> | Pure unit tests: commission maths, webhook signature (16 pass) | The 14 integration tests (written, **skipped** without `TEST_DATABASE_URL`) |
> | | Frontend against the *real* API;  the QR scanner; PDF/QR output |
> | | Every Bachs API detail marked UNVERIFIED (see [docs/PAYMENTS.md](docs/PAYMENTS.md)) |
>
> Expect to fix small bugs on first run. Follow **First run** below in order; each step tells you what to look for. Nothing here claims "it works".

## Quick start

```bash
cp .env.example .env            # fill DATABASE_URL, SESSION_SECRET (32+ chars), SMTP_*, BACHS_*
npm install                     # also runs `prisma generate`
npx prisma migrate dev --name init          # creates the schema (see prisma/MIGRATIONS_README.md)
# then add prisma/guards.sql as a SECOND migration (CHECK constraints, append-only ledger trigger)
npm run db:seed                 # default categories
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run admin:create
npm run dev                     # http://localhost:3000
```

### Bachs credentials
Put your keys in `.env` (never commit them):

```dotenv
BACHS_API_KEY=""
# Signing secret of the webhook endpoint created in the Bachs developer portal
BACHS_WEBHOOK_SECRET=""
```

Use a `sk_sandbox_…` key first. Create a webhook endpoint in the Bachs developer portal pointing at `https://YOUR_DOMAIN/webhooks/bachs`, subscribe to the collection and refund events, and paste its signing secret above. Then run `npm run bachs:check` and follow [docs/PAYMENTS.md](docs/PAYMENTS.md) **before** `BACHS_LIVE_ENABLED=true`.

## First run checklist
1. `npm run check` and `node scripts/import-check.js` pass.
2. `npm run test:unit` passes (16 tests).
3. Create an empty Postgres DB, set `TEST_DATABASE_URL`, run `npm test`. This runs the 14 integration tests against the mock gateway (**they TRUNCATE all tables**; use a throwaway database).
4. `npm run dev`; open `/`, register, create an event as an organizer, publish, buy a free ticket, scan it at `/scan`.
5. Sandbox payment: `npm run bachs:check`, then buy a paid ticket and watch `/admin#/orders`.

## Layout
```
src/config      env parsing (zod); fails fast on bad config
src/lib         prisma, errors, logger, storage (local/S3), mailer, money, secretbox
src/middleware  session (DB-backed), csrf, auth, validate, security (helmet CSP, rate limits)
src/services    business logic (checkout, fulfilment, inventory, refunds, ledger, settlements, analytics, ...)
src/services/payments   gateway interface: bachs.js (real) and mock.js (tests only)
src/routes      thin HTTP layer (there are no separate "controllers"; routes call services)
src/jobs        background tasks + worker
public/         the entire frontend (HTML, CSS, ES modules). No build step.
prisma/         schema + guards.sql
test/unit, test/integration
docs/           PAYMENTS, COMMISSION, DEPLOYMENT, OPERATIONS, API
```

## Documentation
- [docs/PAYMENTS.md](docs/PAYMENTS.md): Bachs integration, what is unverified, sandbox procedure, go-live checklist
- [docs/COMMISSION.md](docs/COMMISSION.md): how commission, refunds, ledger and payouts are calculated
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): production deployment
- [docs/OPERATIONS.md](docs/OPERATIONS.md): jobs, reconciliation, runbooks
- [docs/API.md](docs/API.md): endpoint reference

## Known limitations (also shown where relevant in the UI)
- **Payouts are manual.** The app tracks balances and records payouts; an admin sends the bank transfer and records the reference. It does not move money.
- **Balances are accounting figures** derived from this database, not bank or Bachs balances.
- **Bachs allows one refund per charge** (per the vendor's SDK notes), so the app permits one gateway refund per order. Partial refund followed by another refund on the same order is blocked.
- Refunds do not automatically restock tickets.
- Single currency (NGN) in the UI and settings.
- Seating charts, resale/transfer, recurring events, multi-day passes and per-ticket attendee emails beyond the buyer are **not implemented**.
- Legal pages (`/terms`, `/privacy`, `/refund-policy`) are **templates** and must be reviewed by a lawyer (including NDPR/NDPA compliance).
- No offline scanner mode: scanning needs connectivity (the server enforces one admission per ticket atomically).
- Email uses a DB outbox with retries but needs a working SMTP provider; deliverability (SPF/DKIM/DMARC) is your DNS work.
- Accessibility: semantic HTML, labels, focus states and reduced-motion are implemented but **no audit was run**.
