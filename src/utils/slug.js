import slugify from 'slugify';
import { randomToken } from './crypto.js';

export function baseSlug(title) {
  const s = slugify(String(title), { lower: true, strict: true, trim: true }).slice(0, 60);
  return s || 'event';
}

/** Generates a unique slug using the provided existence check. */
export async function uniqueSlug(title, exists) {
  const base = baseSlug(title);
  if (!(await exists(base))) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 5)}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
