// Regression test: a partial PATCH must not null the fields it did not send.
// Needs zod installed (npm install); not run in the sandbox where this was written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventBody, ticketTypeUpdateBody } from '../../src/validators/events.js';

test('eventBody: omitted optional text fields stay omitted', () => {
  const out = eventBody.parse({ refundPolicy: 'Refunds until a day before', terms: 'Be nice' });
  assert.equal(out.refundPolicy, 'Refunds until a day before');
  for (const k of ['description', 'shortDescription', 'venueName', 'city', 'address', 'entryInstructions', 'ageRestriction']) {
    assert.equal(k in out, false, `${k} must not appear when it was not sent`);
  }
});

test('eventBody: an explicit empty string still clears a field', () => {
  assert.equal(eventBody.parse({ venueName: '' }).venueName, null);
});

test('ticketTypeUpdateBody: omitted description is not cleared', () => {
  assert.equal('description' in ticketTypeUpdateBody.parse({ price: '100' }), false);
});