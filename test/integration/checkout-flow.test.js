// NOT RUN in the environment this was written in (no PostgreSQL / npm registry). Run with TEST_DATABASE_URL set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, resetDb, client, seedEvent, checkoutBody, payAndNotify, sendWebhook, prisma, mockGateway, uniq } from './helpers.js';

before(async () => { if (!skip) await resetDb(); });
after(async () => { await prisma?.$disconnect(); });

test('paid checkout: signed webhook issues tickets once, records commission and ledger', { skip }, async () => {
  const seed = await seedEvent({ price: '5000.00', quantity: 10 });
  const buyer = await client();
  const res = await buyer.post('/api/checkout', checkoutBody(seed, 2));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { reference, accessToken } = res.body.data;
  assert.ok(res.body.data.checkoutUrl);

  // Before payment: no tickets, inventory is only reserved.
  let order = await buyer.get(`/api/orders/${reference}?token=${accessToken}`);
  assert.equal(order.body.data.status, 'PENDING');
  assert.equal(order.body.data.tickets.length, 0);

  const w1 = await payAndNotify(reference);
  assert.equal(w1.status, 200, JSON.stringify(w1.body));
  order = await buyer.get(`/api/orders/${reference}?token=${accessToken}`);
  assert.equal(order.body.data.status, 'PAID');
  assert.equal(order.body.data.tickets.length, 2);
  assert.match(order.body.data.tickets[0].number, /^EH-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  // Duplicate delivery (same event id replayed) does not duplicate anything.
  const payment = await prisma.payment.findFirst({ where: { order: { reference } } });
  const dupe = await sendWebhook({ id: 'evt_dup', type: 'collection.succeeded', data: { object: { id: payment.gatewayCheckoutId, reference } } });
  const dupe2 = await sendWebhook({ id: 'evt_dup', type: 'collection.succeeded', data: { object: { id: payment.gatewayCheckoutId, reference } } });
  assert.equal(dupe.status, 200); assert.equal(dupe2.body.duplicate, true);
  assert.equal(await prisma.ticket.count({ where: { order: { reference } } }), 2);
  assert.equal(await prisma.commissionRecord.count({ where: { order: { reference } } }), 1);

  const ledger = await prisma.organizerLedgerEntry.findMany({ where: { order: { reference } } });
  const sum = ledger.reduce((s, e) => s + Number(e.amount), 0);
  const comm = await prisma.commissionRecord.findFirst({ where: { order: { reference } } });
  assert.equal(sum, 10000 - Number(comm.amount), 'ledger = gross - commission');

  const ev = await prisma.event.findUnique({ where: { id: seed.event.id } });
  assert.equal(ev.ticketsSold, 2);
  assert.equal(ev.ticketsRemaining, 8);
});

test('webhook with a bad signature is rejected and changes nothing', { skip }, async () => {
  const seed = await seedEvent();
  const buyer = await client();
  const { reference } = (await buyer.post('/api/checkout', checkoutBody(seed))).body.data;
  const payment = await prisma.payment.findFirst({ where: { order: { reference } } });
  mockGateway.setCheckout(payment.gatewayCheckoutId, { status: 'succeeded' });
  const bad = await sendWebhook({ id: uniq('evt'), type: 'collection.succeeded', data: { object: { id: payment.gatewayCheckoutId } } }, { signature: 'deadbeef' });
  assert.equal(bad.status, 401);
  const stale = await sendWebhook({ id: uniq('evt'), type: 'collection.succeeded', data: { object: { id: payment.gatewayCheckoutId } } }, { ts: '1000000000' });
  assert.equal(stale.status, 401);
  assert.equal((await prisma.order.findUnique({ where: { reference } })).status, 'PENDING');
});

test('a webhook cannot mark an order paid: the gateway amount is re-checked', { skip }, async () => {
  const seed = await seedEvent({ price: '5000.00' });
  const buyer = await client();
  const { reference } = (await buyer.post('/api/checkout', checkoutBody(seed))).body.data;
  await payAndNotify(reference, { paidMinor: 100 }); // gateway says only NGN 1.00 was paid
  const o = await prisma.order.findUnique({ where: { reference } });
  assert.notEqual(o.status, 'PAID');
  assert.equal(await prisma.ticket.count({ where: { orderId: o.id } }), 0);
});

test('an unpaid webhook ("succeeded" claim, pending at gateway) issues nothing', { skip }, async () => {
  const seed = await seedEvent();
  const buyer = await client();
  const { reference } = (await buyer.post('/api/checkout', checkoutBody(seed))).body.data;
  const payment = await prisma.payment.findFirst({ where: { order: { reference } } });
  await sendWebhook({ id: uniq('evt'), type: 'collection.succeeded', data: { object: { id: payment.gatewayCheckoutId, reference } } }); // mock still 'pending'
  assert.equal((await prisma.order.findUnique({ where: { reference } })).status, 'PENDING');
});

test('free events issue tickets without any gateway call', { skip }, async () => {
  const seed = await seedEvent({ price: '0.00', quantity: 5 });
  const buyer = await client();
  const res = await buyer.post('/api/checkout', checkoutBody(seed, 2));
  assert.equal(res.status, 201);
  assert.equal(res.body.data.free, true);
  assert.equal(mockGateway.getCheckout('chk_mock_1'), undefined);
  const o = await buyer.get(`/api/orders/${res.body.data.reference}?token=${res.body.data.accessToken}`);
  assert.equal(o.body.data.status, 'PAID');
  assert.equal(o.body.data.tickets.length, 2);
  const recs = await prisma.commissionRecord.findMany({ where: { order: { reference: res.body.data.reference } } });
  assert.equal(recs.reduce((s, r) => s + Number(r.amount), 0), 0, 'free orders carry no commission');
});

test('concurrent checkouts for the last tickets never oversell', { skip }, async () => {
  const seed = await seedEvent({ quantity: 3 });
  const attempts = await Promise.all(Array.from({ length: 8 }, async () => { const c = await client(); return c.post('/api/checkout', checkoutBody(seed, 1)); }));
  const ok = attempts.filter((r) => r.status === 201).length;
  assert.equal(ok, 3, `expected exactly 3 successes, got ${ok}: ${attempts.map((r) => r.status)}`);
  const t = await prisma.ticketType.findUnique({ where: { id: seed.type.id } });
  assert.ok(t.quantitySold + t.quantityReserved <= t.quantityTotal);
  assert.equal(t.quantityReserved, 3);
});

test('order pages are private: wrong token and other users get 404', { skip }, async () => {
  const seed = await seedEvent();
  const buyer = await client();
  const { reference, accessToken } = (await buyer.post('/api/checkout', checkoutBody(seed))).body.data;
  const stranger = await client();
  assert.equal((await stranger.get(`/api/orders/${reference}`)).status, 404);
  assert.equal((await stranger.get(`/api/orders/${reference}?token=wrong`)).status, 404);
  assert.equal((await stranger.get(`/api/orders/${reference}?token=${accessToken}`)).status, 200);
});
