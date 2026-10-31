import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCommission, commissionReversal, effectiveRates, percentToBps } from '../../src/services/commission.js';
import { toMinor, fromMinor, formatMoney } from '../../src/lib/money.js';

test('money conversion is exact', () => {
  assert.equal(toMinor('5000.00'), 500000);
  assert.equal(toMinor('0.1') + toMinor('0.2'), 30);
  assert.equal(fromMinor(250000), '2500.00');
  assert.equal(fromMinor(5), '0.05');
  assert.equal(toMinor('10.005'), 1001);
  assert.equal(formatMoney('1234567.5'), '₦1,234,567.50');
  assert.throws(() => toMinor('abc'));
});

test('5% of N5,000 is N250 (spec example)', () => {
  const r = calculateCommission({ lines: [{ unitMinor: 500000, quantity: 1 }], percent: 5 });
  assert.equal(r.total, 25000);
});

test('percentage + fixed per ticket, multiple tickets', () => {
  const r = calculateCommission({ lines: [{ unitMinor: 500000, quantity: 3 }], percent: 5, fixedMinorPerTicket: 10000 });
  assert.equal(r.total, 75000 + 30000);
});

test('rounding is half up per line', () => {
  // 7.5% of 333.33 -> 24.99975 -> 2500 minor
  const r = calculateCommission({ lines: [{ unitMinor: 33333, quantity: 1 }], percent: 7.5 });
  assert.equal(r.total, 2500);
  // 5% of 0.10 = 0.005 -> rounds half up to 0.01
  assert.equal(calculateCommission({ lines: [{ unitMinor: 10, quantity: 1 }], percent: 5 }).total, 1);
});

test('free tickets never carry commission, even with a fixed fee', () => {
  const r = calculateCommission({ lines: [{ unitMinor: 0, quantity: 5 }], percent: 5, fixedMinorPerTicket: 10000 });
  assert.equal(r.total, 0);
});

test('commission never exceeds the line amount', () => {
  const r = calculateCommission({ lines: [{ unitMinor: 5000, quantity: 1 }], percent: 10, fixedMinorPerTicket: 100000 });
  assert.equal(r.total, 5000);
});

test('discounts reduce the commission base', () => {
  const r = calculateCommission({ lines: [{ unitMinor: 100000, quantity: 2, discountMinor: 50000 }], percent: 10 });
  assert.equal(r.lines[0].net, 150000);
  assert.equal(r.total, 15000);
});

test('invalid percent rejected', () => {
  assert.throws(() => percentToBps(101));
  assert.throws(() => percentToBps(-1));
});

test('commission reversal is proportional and capped (partial then full refund)', () => {
  const total = 1000000, commission = 50000;
  const first = commissionReversal({ orderTotalMinor: total, commissionMinor: commission, refundMinor: 250000 });
  assert.equal(first, 12500);
  const second = commissionReversal({ orderTotalMinor: total, commissionMinor: commission, alreadyReversedMinor: first, refundMinor: 750000 });
  assert.equal(second, 37500);
  assert.equal(first + second, commission);
  // refunding more than is left never over-reverses
  const third = commissionReversal({ orderTotalMinor: total, commissionMinor: commission, alreadyReversedMinor: commission, refundMinor: 1000 });
  assert.equal(third, 0);
});

test('event override beats platform default', () => {
  const settings = { commissionPercent: 5, commissionFixedPerTicket: 0 };
  assert.deepEqual(effectiveRates({}, settings), { percent: 5, fixedMinorPerTicket: 0 });
  const ev = { commissionOverridePercent: { toString: () => '3.5' }, commissionOverrideFixed: { toString: () => '50.00' } };
  assert.deepEqual(effectiveRates(ev, settings), { percent: 3.5, fixedMinorPerTicket: 5000 });
});
