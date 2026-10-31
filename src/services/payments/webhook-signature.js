// Bachs webhook signature verification (pure; no framework dependencies).
//
// Verified against docs.bachs.io/guides/webhooks/overview (2026-10-31): HMAC-SHA256, hex, over "{timestamp}.{rawBody}";
// headers X-Bachs-Timestamp + X-Bachs-Signature, or X-Bachs-Signature-V2 "t=<ts>,v1=<sig>[,v1=<sig>]" (one v1 per valid secret
// during rotation). Everything scheme-specific lives in this file so a correction is a one-file change.
import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'x-bachs-signature';
export const TIMESTAMP_HEADER = 'x-bachs-timestamp';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret, timestamp, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function timestampToMs(ts) {
  const s = String(ts).trim();
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000; // epoch seconds or milliseconds
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : d;
}

function candidates(header) {
  // "abcd", "v1=abcd", "sha256=abcd", or a comma/space separated list of those.
  return String(header)
    .split(/[,\s]+/)
    .map((p) => p.replace(/^(v1|sha256)=/i, '').trim())
    .filter(Boolean);
}

function matches(expectedHex, candidate) {
  const expected = Buffer.from(expectedHex, 'hex');
  const given = /^[0-9a-f]+$/i.test(candidate) && candidate.length === expectedHex.length
    ? Buffer.from(candidate, 'hex')
    : Buffer.from(candidate, 'base64');
  return given.length === expected.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Fails closed: any missing piece is a rejection.
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyWebhookSignature({ rawBody, signature, timestamp, secrets, nowMs = Date.now(), toleranceSeconds = DEFAULT_TOLERANCE_SECONDS }) {
  const usable = (secrets || []).filter((s) => typeof s === 'string' && s.length > 0);
  if (usable.length === 0) return { ok: false, reason: 'no_secret_configured' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing_headers' };
  const tsMs = timestampToMs(timestamp);
  if (tsMs === null) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(nowMs - tsMs) > toleranceSeconds * 1000) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const given = candidates(signature);
  for (const secret of usable) {
    const expected = computeSignature(secret, timestamp, rawBody);
    if (given.some((c) => matches(expected, c))) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}