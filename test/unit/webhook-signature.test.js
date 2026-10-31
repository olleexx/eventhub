import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, verifyWebhookSignature } from '../../src/services/payments/webhook-signature.js';

const secret = 'whsec_test_secret';
const body = JSON.stringify({ id: 'evt_1', type: 'collection.succeeded', data: { id: 'chk_1' } });
const nowMs = Date.UTC(2026, 9, 27, 12, 0, 0);
const ts = String(Math.floor(nowMs / 1000));

test('valid signature verifies', () => {
  const sig = computeSignature(secret, ts, body);
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secrets: [secret], nowMs }).ok, true);
  assert.equal(verifyWebhookSignature({ rawBody: Buffer.from(body), signature: `v1=${sig}`, timestamp: ts, secrets: [secret], nowMs }).ok, true);
});

test('tampered body is rejected', () => {
  const sig = computeSignature(secret, ts, body);
  const r = verifyWebhookSignature({ rawBody: body.replace('chk_1', 'chk_2'), signature: sig, timestamp: ts, secrets: [secret], nowMs });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature_mismatch');
});

test('wrong secret / missing secret / missing headers are rejected (fail closed)', () => {
  const sig = computeSignature(secret, ts, body);
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secrets: ['other'], nowMs }).ok, false);
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secrets: [''], nowMs }).reason, 'no_secret_configured');
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: '', timestamp: ts, secrets: [secret], nowMs }).reason, 'missing_headers');
});

test('stale timestamps are rejected (replay protection)', () => {
  const old = String(Math.floor(nowMs / 1000) - 3600);
  const sig = computeSignature(secret, old, body);
  const r = verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: old, secrets: [secret], nowMs });
  assert.equal(r.reason, 'timestamp_out_of_tolerance');
});

test('previous secret accepted during rotation', () => {
  const sig = computeSignature('old_secret', ts, body);
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secrets: [secret, 'old_secret'], nowMs }).ok, true);
});

test('ISO timestamps supported', () => {
  const iso = new Date(nowMs).toISOString();
  const sig = computeSignature(secret, iso, body);
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: iso, secrets: [secret], nowMs }).ok, true);
});
