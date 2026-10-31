// AES-256-GCM helper for the few secrets we must be able to read back (organizer payout account
// numbers). Key is derived from SESSION_SECRET with scrypt; rotating SESSION_SECRET makes stored
// values unreadable, so organizers would re-enter bank details (documented in docs/OPERATIONS.md).
import crypto from 'node:crypto';
import { config } from '../config/env.js';

let key;
const getKey = () => (key ??= crypto.scryptSync(config.SESSION_SECRET, 'eventhub-secretbox-v1', 32));

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload) {
  try {
    const [v, iv, tag, data] = String(payload).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
