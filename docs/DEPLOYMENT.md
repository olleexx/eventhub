# Deployment

None of this has been executed; treat the Dockerfile and compose file as a starting point and test them.

## Requirements
Node 20+, PostgreSQL 14+ (needs the `pg_trgm` extension for search), an SMTP provider, an HTTPS domain, S3-compatible storage for uploads (a local disk is lost on ephemeral hosts).

## Environment (production)
`NODE_ENV=production`, `APP_URL=https://your.domain` (must be https), `DATABASE_URL`, `SESSION_SECRET` (32+ random chars; also derives the payout-account encryption key: **rotating it makes stored account numbers undecryptable**, so back it up), `TRUST_PROXY=1` behind one proxy, `SMTP_*`, `BACHS_*`, `STORAGE_DRIVER=s3` + `S3_*`, `CRON_SECRET`. `PAYMENTS_DRIVER=mock` is refused.

## Steps
1. Provision Postgres and run `CREATE EXTENSION IF NOT EXISTS pg_trgm;` if your role may not do it automatically.
2. **Generate migrations once, in development** (`npx prisma migrate dev --name init`), add `prisma/guards.sql` as a second migration, commit `prisma/migrations/`. Production runs `npx prisma migrate deploy` only. See `prisma/MIGRATIONS_README.md`.
3. Build/run the container (`docker build -t eventhub .`) or `npm ci --omit=dev && npm start`.
4. Create the first admin: `ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run admin:create`.
5. Register the webhook `https://your.domain/webhooks/bachs` in the Bachs portal; set the secret.
6. Jobs: either leave `RUN_WORKER_IN_PROCESS=true` (single instance) or run `npm run worker` as a separate process and set it to false in the web process. On serverless/sleeping hosts, call `POST /internal/cron/all` every minute with `Authorization: Bearer $CRON_SECRET`.
7. Put a TLS-terminating proxy in front. Forward the real client IP (rate limiting uses it). Do not strip the raw body on `/webhooks/bachs`.
8. Health: `GET /healthz` (liveness), `GET /readyz` (checks the database).

## Backups and recovery
Back up Postgres (PITR if possible). The ledger, orders, tickets and audit log are the system of record. Test a restore before launch. Uploads live in your bucket. Keep `SESSION_SECRET` in your secret manager.

## Security notes
Helmet CSP (no inline scripts), DB-backed sessions (httpOnly, SameSite=Lax, `__Host-` prefix in prod), CSRF token + Origin check, argon2id passwords with lockout, rate limits on auth/checkout/scan, zod validation on every body/query, object-level authorization on every organizer/admin route, audit log for sensitive actions, uploads re-encoded by sharp. Run `npm audit` and pin/update dependencies yourself; this was not done.
