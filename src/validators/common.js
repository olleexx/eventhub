import { z } from 'zod';

export const id = z.string().min(5).max(40).regex(/^[a-z0-9]+$/i);
export const email = z.string().trim().toLowerCase().email().max(200);
export const password = z.string().min(10, 'Use at least 10 characters').max(200);
export const trimmed = (max, min = 1) => z.string().trim().min(min).max(max);
export const optText = (max) => z.string().trim().max(max).optional().nullable().transform((v) => (v === undefined ? undefined : v ? v : null)); // keep "not sent" as undefined, otherwise a PATCH would null every omitted field
export const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');
export const isoDate = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.date().optional());
export const money = z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.union([z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Invalid amount'), z.number().min(0).max(9_999_999_999)]).transform(String));
export const httpUrl = z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Must start with http:// or https://');
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});