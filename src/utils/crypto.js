import crypto from 'node:crypto';

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacSha256Hex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time string comparison (length-safe). */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still do a comparison to keep timing roughly constant
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Human-friendly ticket number, e.g. EH-7K2M-9QX4 (no ambiguous characters).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function ticketNumber(prefix = 'EH') {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${out.slice(0, 4)}-${out.slice(4)}`;
}

export function orderReference() {
  const bytes = crypto.randomBytes(9);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `ORD-${out}`;
}

export function uuid() {
  return crypto.randomUUID();
}

/**
 * Deterministic bearer token that lets a guest view one order. Derived from the order reference
 * with an HMAC so emails can embed it at send time; only its SHA-256 is stored on the order.
 * Rotating SESSION_SECRET invalidates previously emailed links (documented).
 */
export function orderAccessToken(reference, secret) {
  return crypto.createHmac('sha256', secret).update(`order-access:${reference}`).digest('base64url').slice(0, 32);
}
