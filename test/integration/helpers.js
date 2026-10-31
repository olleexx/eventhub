// Integration-test helpers. These tests need a REAL PostgreSQL database: set TEST_DATABASE_URL.
// They are skipped (not failed) when it is missing so `npm test` stays honest on machines without a DB.
// WARNING: every table is TRUNCATED before each test file. Never point TEST_DATABASE_URL at real data.
process.env.NODE_ENV = 'test';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
process.env.SESSION_SECRET ||= 'test-session-secret-test-session-secret-0123456789';
process.env.APP_URL = 'http://localhost:3000';
process.env.BACHS_WEBHOOK_SECRET = 'whsec_integration_test';
process.env.RUN_WORKER_IN_PROCESS = 'false';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = './uploads-test';

export const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);
export const skip = HAS_DB ? false : 'TEST_DATABASE_URL not set: integration tests need PostgreSQL';

// Heavy imports only happen when a database is configured, so `npm test` skips cleanly without one.
let supertest, createApp, prisma, computeSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, mockGateway, ensureDefaultCategories;
if (HAS_DB) {
  ({ default: supertest } = await import('supertest'));
  ({ createApp } = await import('../../src/app.js'));
  ({ prisma } = await import('../../src/lib/prisma.js'));
  ({ computeSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } = await import('../../src/services/payments/webhook-signature.js'));
  ({ mockGateway } = await import('../../src/services/payments/mock.js'));
  ({ ensureDefaultCategories } = await import('../../src/services/categories.js'));
}
export { prisma, mockGateway };

export const app = HAS_DB ? createApp() : null;
export const ORIGIN = 'http://localhost:3000';

export async function resetDb() {
  const rows = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  // The ledger is append-only by trigger; TRUNCATE bypasses row-level triggers, which is what we want for test cleanup.
  await prisma.$executeRawUnsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  mockGateway.reset();
  await ensureDefaultCategories();
}

/** A browser-like client: keeps the session cookie and the CSRF token. */
export async function client() {
  const agent = supertest.agent(app);
  const me = await agent.get('/api/auth/me');
  let csrf = me.body.data.csrfToken;
  const wrap = (method) => (url, body) => {
    let r = agent[method](url).set('Origin', ORIGIN);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return body === undefined ? r : r.send(body);
  };
  const c = { agent, get: (u) => agent.get(u), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), del: wrap('delete'),
    async refreshCsrf() { const r = await agent.get('/api/auth/me'); csrf = r.body.data.csrfToken; return csrf; } };
  c.register = async (data) => { const r = await c.post('/api/auth/register', { acceptTerms: true, password: 'CorrectHorse-Battery1', ...data }); await c.refreshCsrf(); return r; };
  c.login = async (email, password = 'CorrectHorse-Battery1') => { const r = await c.post('/api/auth/login', { email, password }); await c.refreshCsrf(); return r; };
  return c;
}

let n = 0;
export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${++n}`;

/** Organizer account (verified) with a published event and one ticket type, created straight in the DB. */
export async function seedEvent({ price = '5000.00', quantity = 10, title = 'Test Fest', organizerEmail } = {}) {
  const email = organizerEmail || `${uniq('org')}@example.test`;
  const c = await client();
  const reg = await c.register({ name: 'Olu Organizer', email, asOrganizer: true, brandName: 'Olu Events' });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const user = await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() }, include: { organizer: true } });
  await c.refreshCsrf();
  const event = await prisma.event.create({ data: {
    organizerId: user.organizer.id, title, slug: uniq('ev'), status: 'PUBLISHED', publishedAt: new Date(),
    startsAt: new Date(Date.now() + 7 * 864e5), endsAt: new Date(Date.now() + 7 * 864e5 + 3 * 36e5), venueName: 'Hall', city: 'Lagos',
    shortDescription: 'A test event for integration tests', description: 'Long enough description for the test event.', refundPolicy: 'Refunds until a day before.', terms: 'Be nice.',
    refundDeadline: new Date(Date.now() + 5 * 864e5), minPrice: price, ticketsRemaining: quantity,
  } });
  const type = await prisma.ticketType.create({ data: { eventId: event.id, name: 'General', price, quantityTotal: quantity, maxPerOrder: 10 } });
  return { organizer: c, user, event, type, email };
}

export const checkoutBody = (seed, quantity = 1, email = `${uniq('buyer')}@example.test`) => ({ eventId: seed.event.id, items: [{ ticketTypeId: seed.type.id, quantity }], buyer: { name: 'Bola Buyer', email } });

/** Deliver a correctly signed webhook, like the provider would. */
export function sendWebhook(payload, { secret = process.env.BACHS_WEBHOOK_SECRET, ts = String(Math.floor(Date.now() / 1000)), signature } = {}) {
  const body = JSON.stringify(payload);
  return supertest(app).post('/webhooks/bachs').set('Content-Type', 'application/json')
    .set(TIMESTAMP_HEADER, ts).set(SIGNATURE_HEADER, signature ?? computeSignature(secret, ts, body)).send(body);
}

/** Simulate "the customer paid at the gateway" in the mock, then deliver the webhook. */
export async function payAndNotify(reference, { paidMinor } = {}) {
  const payment = await prisma.payment.findFirst({ where: { order: { reference } }, orderBy: { createdAt: 'desc' } });
  mockGateway.setCheckout(payment.gatewayCheckoutId, { status: 'succeeded', ...(paidMinor !== undefined ? { paidMinor } : {}) });
  return sendWebhook({ id: uniq('evt'), type: 'collection.succeeded', data: { object: { id: payment.gatewayCheckoutId, reference } } });
}
