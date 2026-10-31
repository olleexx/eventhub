# API reference (summary)

JSON: `{ ok: true, data, meta? }` or `{ ok: false, error: { code, message, details? } }`. Lists return `meta: { page, pageSize, total, totalPages }`.
Auth: cookie session. Mutations need `X-CSRF-Token` (from `GET /api/auth/me`) and a same-origin `Origin`.

**Public** `GET /api/home` · `/api/categories` · `/api/events?q&category&city&from&to&price&available&sort&page` · `/api/events/:slug` · `POST /api/discounts/preview` · `POST /api/events/:id/waitlist|report` · `PUT|DELETE /api/events/:id/favorite` · `POST /api/support`
**Auth** `GET /api/auth/me` · `POST register|login|logout|verify-email|resend-verification|forgot-password|reset-password|change-password|become-organizer` · `PATCH profile`
**Checkout/orders** `POST /api/checkout` · `POST /api/orders/lookup` · `GET /api/orders/:ref?token=` · `GET /api/orders/:ref/tickets.pdf` · `POST /api/orders/:ref/refund-request` · `GET /api/me/orders|tickets|favorites`
**Organizer** `/api/organizer/…`: overview, events (CRUD, checklist, publish, unpublish, duplicate, cancel, announce, banner, images, ticket-types, discounts, analytics, activity, attendees(.csv), staff, appeal), orders(.csv), refunds, finance, payout-details, settlements, profile, scannable-events
**Check-in** `POST /api/checkin/:eventId/scan` · `GET …/stats` · `POST …/undo/:ticketId`
**Admin** `/api/admin/…`: overview, users, organizers, events (moderate, commission), orders, refunds, settlements, reconciliation, reports, audit, settings, categories, announcements, email, system
**Webhook** `POST /webhooks/bachs` (raw body, signed) · **Cron** `POST /internal/cron/:task` (bearer)

The authoritative definition is the route files in `src/routes/` and zod schemas in `src/validators/`.
