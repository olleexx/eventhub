// Organizer accounting ledger.
//
// OrganizerLedgerEntry rows are append-only (a DB trigger in prisma/guards.sql rejects UPDATE/DELETE).
// Mistakes are corrected with reversing entries. Each entry has a unique idempotencyKey so retried
// webhooks / jobs can never double-post.
//
// IMPORTANT: a ledger balance is an accounting figure of what the platform OWES an organizer. It is
// not money in any bank account and it is not "paid" until a Settlement reaches status PAID.
import { prisma, Prisma } from '../lib/prisma.js';
import { toMinor, fromMinor } from '../lib/money.js';

export async function postEntries(client, entries) {
  if (!entries.length) return 0;
  const r = await client.organizerLedgerEntry.createMany({ data: entries, skipDuplicates: true });
  return r.count;
}

export function availableAtFor(event, holdDays, now = new Date()) {
  const base = event?.endsAt && event.endsAt > now ? event.endsAt : now;
  return new Date(base.getTime() + holdDays * 86_400_000);
}

const asMinor = (v) => (v == null ? 0 : toMinor(String(v)));

/**
 * Balance breakdown (all minor-unit numbers, plus formatted strings).
 *  earned     = sales - commission - refunds + commission reversals (before payouts)
 *  pending    = entries still inside the refund-risk hold (availableAt in the future)
 *  available  = total - pending            (may be negative if refunds exceed released funds)
 *  settlementsRequested/Approved = amounts reserved by a payout not yet marked PAID
 *  paidOut    = settlements marked PAID
 */
export async function organizerBalance(organizerId, client = prisma) {
  const [row] = await client.$queryRaw(Prisma.sql`
    SELECT
      COALESCE(SUM("amount") FILTER (WHERE "type" IN ('SALE','COMMISSION','REFUND','COMMISSION_REVERSAL')), 0)::text AS earned,
      COALESCE(SUM("amount"), 0)::text AS total,
      COALESCE(SUM("amount") FILTER (WHERE "availableAt" > now()), 0)::text AS pending
    FROM "OrganizerLedgerEntry" WHERE "organizerId" = ${organizerId}`);
  const settlements = await client.settlement.groupBy({ by: ['status'], where: { organizerId }, _sum: { amount: true } });
  const sum = (s) => asMinor(settlements.find((x) => x.status === s)?._sum.amount);
  const total = asMinor(row.total);
  const pending = asMinor(row.pending);
  const out = {
    earned: asMinor(row.earned),
    total,
    pending,
    available: total - pending,
    settlementsRequested: sum('REQUESTED'),
    settlementsApproved: sum('APPROVED'),
    paidOut: sum('PAID'),
  };
  return { ...out, formatted: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, fromMinor(v)])) };
}

/** Lock the organizer row so concurrent settlement requests cannot both spend the same funds. */
export async function lockOrganizer(tx, organizerId) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrganizerProfile" WHERE "id" = ${organizerId} FOR UPDATE`);
}
