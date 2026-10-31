import { z } from 'zod';
import { id, email, trimmed, phone } from './common.js';

const answers = z.record(z.string().max(40), z.union([z.string().max(300), z.boolean()])).refine((o) => Object.keys(o).length <= 12, 'Too many answers');

export const checkoutBody = z.object({
  eventId: id,
  items: z.array(z.object({ ticketTypeId: id, quantity: z.coerce.number().int().min(1).max(100) }).strict()).min(1).max(10),
  buyer: z.object({ name: trimmed(100, 2), email, phone: phone.optional().or(z.literal('').transform(() => undefined)) }).strict(),
  discountCode: z.string().trim().toUpperCase().max(20).optional().or(z.literal('').transform(() => undefined)),
  referralSource: z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{1,40}$/).optional(),
  attendees: z.array(z.object({ name: trimmed(100, 2), email: email.optional(), answers: answers.optional() }).strict()).max(100).optional(),
  answers: answers.optional(),
}).strict();

export const discountPreviewBody = z.object({ eventId: id, code: z.string().trim().min(1).max(20), items: z.array(z.object({ ticketTypeId: id, quantity: z.coerce.number().int().min(1).max(100) }).strict()).min(1).max(10) }).strict();

export const lookupBody = z.object({ email }).strict();
export const refundRequestBody = z.object({ reason: trimmed(500, 5), ticketIds: z.array(id).max(100).optional() }).strict();
export const waitlistBody = z.object({ email, ticketTypeId: id.optional() }).strict();
