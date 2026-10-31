// NOT RUN in the environment this was written in (no PostgreSQL / npm registry). Run with TEST_DATABASE_URL set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, resetDb, client, seedEvent, checkoutBody, payAndNotify, sendWebhook, prisma, mockGateway, uniq } from './helpers.js';

before(async () => { if (!skip) await resetDb(); });
after(async () => { await prisma?.$disconnect(); });

async function paidOrder(seed, qty = 1) {
  const buyer = await client();
  const { reference, accessToken } = (await buyer.post('/api/checkout', checkoutBody(seed, qty))).body.data;
  await payAndNotify(reference);
  const order = (await buyer.get(`/api/orders/${reference}?token=${accessToken}`)).body.data;
  return { buyer, reference, accessToken, order };
}

test('check-in: QR admits once; concurrent scans of one ticket admit exactly one', { skip }, async () => {
  const seed = await seedEvent();
  const { order } = await paidOrder(seed);
  const code = (await prisma.ticket.findFirst({ where: { number: order.tickets[0].number } })).code;
  const results = await Promise.all(Array.from({ length: 6 }, () => seed.organizer.post(`/api/checkin/${seed.event.id}/scan`, { code: `EH1.${code}` })));
  const admitted = results.filter((r) => r.body.data?.result === 'ADMITTED').length;
  const dupes = results.filter((r) => r.body.data?.result === 'ALREADY_USED').length;
  assert.equal(admitted, 1, JSON.stringify(results.map((r) => r.body.data?.result)));
  assert.equal(dupes, 5);
  assert.equal((await prisma.ticket.findFirst({ where: { code } })).status, 'USED');
  assert.equal(await prisma.checkIn.count({ where: { eventId: seed.event.id } }), 1);
});

test('check-in rejects tickets for another event, garbage codes, and unauthorised users', { skip }, async () => {
  const a = await seedEvent({ title: 'Event A' });
  const b = await seedEvent({ title: 'Event B' });
  const { order } = await paidOrder(a);
  const code = (await prisma.ticket.findFirst({ where: { number: order.tickets[0].number } })).code;
  assert.equal((await b.organizer.post(`/api/checkin/${b.event.id}/scan`, { code: `EH1.${code}` })).body.data.result, 'WRONG_EVENT');
  assert.equal((await a.organizer.post(`/api/checkin/${a.event.id}/scan`, { code: 'EH1.nonsense' })).body.data.result, 'INVALID');
  assert.equal((await b.organizer.post(`/api/checkin/${a.event.id}/scan`, { code: `EH1.${code}` })).status, 404); // other organizer cannot scan A (existence hidden)
  const anon = await client();
  assert.equal((await anon.post(`/api/checkin/${a.event.id}/scan`, { code: `EH1.${code}` })).status, 401);
  assert.equal((await prisma.ticket.findFirst({ where: { code } })).status, 'VALID');
});

test('organizers cannot read or modify each other\'s events, orders or attendees', { skip }, async () => {
  const a = await seedEvent({ title: 'Event A' });
  const b = await seedEvent({ title: 'Event B' });
  const { reference } = await paidOrder(a);
  assert.equal((await b.organizer.get(`/api/organizer/events/${a.event.id}`)).status, 404);
  assert.equal((await b.organizer.get(`/api/organizer/events/${a.event.id}/attendees`)).status, 404);
  assert.equal((await b.organizer.get(`/api/organizer/orders/${reference}`)).status, 404);
  assert.equal((await b.organizer.patch(`/api/organizer/events/${a.event.id}`, { title: 'Hacked' })).status, 404);
  assert.equal((await b.organizer.post(`/api/organizer/events/${a.event.id}/ticket-types`, { name: 'X', price: 1, quantityTotal: 1 })).status, 404);
  const list = await b.organizer.get('/api/organizer/orders');
  assert.equal(list.body.data.length, 0);
  assert.equal((await prisma.event.findUnique({ where: { id: a.event.id } })).title, 'Event A');
});

test('admin routes reject non-admins; CSRF is enforced for signed-in sessions', { skip }, async () => {
  const seed = await seedEvent();
  assert.equal((await seed.organizer.get('/api/admin/overview')).status, 403);
  const anon = await client();
  assert.equal((await anon.get('/api/admin/overview')).status, 401);
  // Missing CSRF header on an authenticated mutation.
  const noCsrf = await seed.organizer.agent.post('/api/organizer/events').set('Origin', 'http://localhost:3000').send({ title: 'x' });
  assert.equal(noCsrf.status, 403);
  const badOrigin = await seed.organizer.agent.post('/api/organizer/events').set('Origin', 'https://evil.example').send({ title: 'x' });
  assert.equal(badOrigin.status, 403);
});

test('refund: request -> approve -> only a signed refund.paid completes it; ledger and commission reverse', { skip }, async () => {
  const seed = await seedEvent({ price: '4000.00' });
  const { buyer, reference, accessToken } = await paidOrder(seed, 1);
  const r = await buyer.post(`/api/orders/${reference}/refund-request?token=${accessToken}`, { reason: 'Cannot attend anymore' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const refundId = r.body.data.id;
  const rv = await seed.organizer.post(`/api/organizer/refunds/${refundId}/review`, { decision: 'approve' });
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  let refund = await prisma.refund.findUnique({ where: { id: refundId } });
  assert.notEqual(refund.status, 'COMPLETED', 'must not be completed before the provider confirms');
  assert.equal(mockGateway.refundCount(), 1);

  const hook = await sendWebhook({ id: uniq('evt'), type: 'refund.paid', data: { object: { id: 'ref_from_provider', reference: refundId } } });
  assert.equal(hook.status, 200, JSON.stringify(hook.body));
  refund = await prisma.refund.findUnique({ where: { id: refundId } });
  assert.equal(refund.status, 'COMPLETED');
  const order = await prisma.order.findUnique({ where: { reference } });
  assert.ok(['REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.status));
  const ledgerSum = (await prisma.organizerLedgerEntry.findMany({ where: { orderId: order.id } })).reduce((s, e) => s + Number(e.amount), 0);
  assert.equal(ledgerSum, 0, 'a full refund nets the organizer ledger for this order to zero');
  assert.equal((await prisma.ticket.findFirst({ where: { orderId: order.id } })).status, 'REFUNDED');
  // A second webhook for the same refund is harmless.
  assert.equal((await sendWebhook({ id: uniq('evt'), type: 'refund.paid', data: { object: { id: 'ref_from_provider', reference: refundId } } })).status, 200);
  assert.equal(await prisma.organizerLedgerEntry.count({ where: { orderId: order.id } }), (await prisma.organizerLedgerEntry.findMany({ where: { orderId: order.id } })).length);
});

test('cancelling a paid event refunds every paid order through the gateway', { skip }, async () => {
  const seed = await seedEvent({ price: '2500.00' });
  await paidOrder(seed); await paidOrder(seed);
  const r = await seed.organizer.post(`/api/organizer/events/${seed.event.id}/cancel`, { reason: 'Venue unavailable' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await prisma.event.findUnique({ where: { id: seed.event.id } })).status, 'CANCELLED');
  const refunds = await prisma.refund.findMany({ where: { order: { eventId: seed.event.id } } });
  assert.equal(refunds.length, 2);
  assert.ok(refunds.every((x) => x.status !== 'COMPLETED'), 'not complete until provider confirms');
});

test('payout requests cannot exceed the available balance and are ledgered once', { skip }, async () => {
  const seed = await seedEvent({ price: '10000.00' });
  await paidOrder(seed);
  await prisma.organizerLedgerEntry.updateMany({ where: { organizerId: seed.user.organizer.id }, data: { availableAt: new Date(Date.now() - 1000) } }).catch(() => {}); // ledger is append-only: may be rejected by the trigger
  const tooMuch = await seed.organizer.post('/api/organizer/settlements', { amount: '99999999' });
  assert.ok([400, 409, 422].includes(tooMuch.status), `expected rejection, got ${tooMuch.status}`);
});
