import { z } from 'zod';
import { id, trimmed, optText, httpUrl, money, isoDate, pageQuery } from './common.js';

const question = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,30}$/),
  label: trimmed(120),
  type: z.enum(['text', 'select', 'checkbox']).default('text'),
  required: z.boolean().default(false),
  options: z.array(trimmed(60)).max(12).optional(),
}).strict();

const tz = z.string().refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Unknown time zone');

// All fields optional: drafts may be saved incomplete. Completeness is enforced at publish time.
export const eventBody = z.object({
  title: trimmed(120, 3).optional(),
  categoryId: id.nullable().optional(),
  shortDescription: optText(240),
  description: optText(10_000),
  startsAt: isoDate,
  endsAt: isoDate,
  timezone: tz.optional(),
  venueName: optText(160),
  city: optText(80),
  address: optText(300),
  onlineUrl: httpUrl.optional().nullable().or(z.literal('').transform(() => null)),
  mapUrl: httpUrl.optional().nullable().or(z.literal('').transform(() => null)),
  venueInstructions: optText(1000),
  entryInstructions: optText(2000),
  refundPolicy: optText(2000),
  terms: optText(5000),
  ageRestriction: optText(60),
  refundDeadline: isoDate,
  scheduledPublishAt: isoDate,
  customQuestions: z.array(question).max(8).optional(),
  ticketDesign: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), note: z.string().max(200).optional() }).strict().optional(),
}).strict();

export const ticketTypeBody = z.object({
  name: trimmed(80),
  description: optText(500),
  price: money,
  quantityTotal: z.coerce.number().int().min(1).max(1_000_000),
  minPerOrder: z.coerce.number().int().min(1).max(100).default(1),
  maxPerOrder: z.coerce.number().int().min(1).max(100).default(10),
  perCustomerLimit: z.coerce.number().int().min(1).max(1000).nullable().optional(),
  salesStartAt: isoDate.nullable().optional(),
  salesEndAt: isoDate.nullable().optional(),
  visible: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
}).strict().refine((t) => t.minPerOrder <= t.maxPerOrder, { message: 'Minimum per order cannot exceed maximum', path: ['minPerOrder'] })
  .refine((t) => !t.salesStartAt || !t.salesEndAt || t.salesStartAt < t.salesEndAt, { message: 'Sales must close after they open', path: ['salesEndAt'] });

export const ticketTypeUpdateBody = z.object({
  name: trimmed(80).optional(),
  description: optText(500),
  price: money.optional(),
  quantityTotal: z.coerce.number().int().min(0).max(1_000_000).optional(),
  minPerOrder: z.coerce.number().int().min(1).max(100).optional(),
  maxPerOrder: z.coerce.number().int().min(1).max(100).optional(),
  perCustomerLimit: z.coerce.number().int().min(1).max(1000).nullable().optional(),
  salesStartAt: isoDate.nullable().optional(),
  salesEndAt: isoDate.nullable().optional(),
  visible: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
}).strict();

export const discountBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/, '3-20 letters, numbers, - or _'),
  percentOff: z.coerce.number().min(1).max(100).nullable().optional(),
  amountOff: money.nullable().optional(),
  maxUses: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
  active: z.boolean().default(true),
}).strict().refine((d) => Boolean(d.percentOff) !== Boolean(d.amountOff && Number(d.amountOff) > 0), { message: 'Set either a percentage or a fixed amount off' });

export const cancelBody = z.object({ reason: trimmed(500, 5) }).strict();
export const announceBody = z.object({ message: trimmed(1000, 5) }).strict();

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  city: z.string().trim().max(80).optional(),
  organizer: z.string().trim().max(100).optional(),
  from: isoDate,
  to: isoDate,
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  price: z.enum(['free', 'paid']).optional(),
  available: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  sort: z.enum(['date', 'popular', 'new', 'price_asc', 'price_desc']).default('date'),
}).merge(pageQuery);

export const reportBody = z.object({ reason: z.enum(['scam', 'inappropriate', 'misleading', 'duplicate', 'other']), details: optText(1000) }).strict();
