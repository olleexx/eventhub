import { z } from 'zod';
import { id, trimmed, optText, money, isoDate, pageQuery, email } from './common.js';

export const statusBody = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: trimmed(300, 3) }).strict();
export const orgSuspendBody = z.object({ suspended: z.boolean(), reason: trimmed(300, 3) }).strict();
export const moderateBody = z.object({ action: z.enum(['suspend', 'unpublish', 'restore', 'feature', 'unfeature']), note: z.string().trim().max(500).default('') }).strict()
  .refine((b) => !['suspend', 'unpublish'].includes(b.action) || b.note.length >= 5, { message: 'Give a reason (5+ characters)', path: ['note'] });
export const commissionOverrideBody = z.object({ percent: z.coerce.number().min(0).max(100).nullable().optional(), fixed: money.nullable().optional() }).strict();
export const reportResolveBody = z.object({ status: z.enum(['REVIEWING', 'ACTIONED', 'DISMISSED']), resolution: optText(500) }).strict();
export const appealBody = z.object({ message: trimmed(2000, 10) }).strict();
export const appealDecisionBody = z.object({ decision: z.enum(['uphold', 'dismiss']), response: trimmed(1000, 3) }).strict();
export const supportBody = z.object({ email: email.optional(), subject: trimmed(150, 3), message: trimmed(3000, 10) }).strict();
export const supportReplyBody = z.object({ reply: trimmed(3000, 3) }).strict();
export const orderResolveBody = z.object({ action: z.enum(['recheck', 'refund_full']) }).strict();
export const categoryBody = z.object({ name: trimmed(60, 2).optional(), active: z.boolean().optional(), sortOrder: z.coerce.number().int().min(0).max(1000).optional() }).strict();
export const announcementBody = z.object({ title: trimmed(120, 3), body: trimmed(1000, 3), active: z.boolean().default(true), startsAt: isoDate.nullable().optional(), endsAt: isoDate.nullable().optional() }).strict();
export const settlementRequestBody = z.object({ amount: money, note: optText(300) }).strict();
export const adminSettlementBody = z.object({ organizerId: id, amount: money, note: optText(300) }).strict();
export const settlementRejectBody = z.object({ note: trimmed(300, 3) }).strict();
export const settlementPaidBody = z.object({ externalReference: trimmed(120, 3) }).strict();
export const manualRefundBody = z.object({ reference: trimmed(120, 3), note: trimmed(300, 3) }).strict();
export const payoutDetailsBody = z.object({ bankName: trimmed(80, 2), accountName: trimmed(120, 2), accountNumber: z.string().trim().regex(/^\d{10}$/, 'NUBAN account numbers have 10 digits') }).strict();
export const staffInviteBody = z.object({ email, role: z.enum(['SCANNER', 'ATTENDEE_VIEWER', 'MANAGER']) }).strict();
export const scanBody = z.object({ code: trimmed(200), scanId: z.string().min(8).max(64).optional(), method: z.enum(['QR', 'MANUAL']).default('QR') }).strict();
export const reviewBody = z.object({ decision: z.enum(['approve', 'reject']), note: optText(500) }).strict();
export const initiateRefundBody = z.object({ reason: trimmed(500, 5), ticketIds: z.array(id).max(100).optional() }).strict();
export const orgListQuery = pageQuery.extend({ q: z.string().trim().max(100).optional(), status: z.string().max(30).optional(), eventId: id.optional(), sort: z.enum(['new', 'old', 'total_desc', 'total_asc']).optional(), from: isoDate, to: isoDate });
export const brandBody = z.object({ brandName: trimmed(100, 2).optional(), bio: optText(1000), website: z.string().trim().url().max(300).optional().nullable().or(z.literal('').transform(() => null)), supportEmail: email.optional().nullable() }).strict();
export const rangeQuery = z.object({ preset: z.enum(['today', '7d', '30d', 'custom']).optional(), from: isoDate, to: isoDate });
