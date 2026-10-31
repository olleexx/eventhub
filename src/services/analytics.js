// Analytics: every figure comes from SQL aggregation over real rows (no hard-coded demo numbers).
// Definitions (kept consistent everywhere and shown in the UI):
//   gross sales   = SUM(order.total) for orders that were paid (PAID, PARTIALLY_REFUNDED, REFUNDED), by paidAt
//   refunds       = SUM(refund.amount) for COMPLETED refunds, by completedAt
//   commission    = SUM(commissionRecord.amount) - SUM(commissionRecord.reversedAmount)   (net of reversals)
//   net earnings  = gross - refunds - commission(net)      (what the organizer has earned, before payout)
//   pending       = orders awaiting payment (not counted as sales)
import { prisma, Prisma } from '../lib/prisma.js';
import { toMinor, fromMinor } from '../lib/money.js';
import { organizerBalance } from './ledger.js';

const TZ = 'Africa/Lagos';
const PAID = Prisma.sql`('PAID','PARTIALLY_REFUNDED','REFUNDED')`;
const n = (v) => (v == null ? 0 : toMinor(String(v)));
const money = (m) => fromMinor(m);

export function resolveRange({ preset, from, to } = {}) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
  if (preset === 'today') return { from: startOfDay(now), to: now };
  if (preset === '7d') return { from: new Date(now.getTime() - 7 * 86_400_000), to: now };
  if (preset === '30d') return { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
  if (from || to) return { from: from ?? new Date(0), to: to ?? now };
  return { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
}

async function totals({ organizerId, eventId, from, to }) {
  const scope = eventId ? Prisma.sql`o."eventId" = ${eventId}` : Prisma.sql`e."organizerId" = ${organizerId}`;
  const [sales] = await prisma.$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(o."total"),0)::text AS gross, COUNT(*)::int AS orders,
           COALESCE(SUM(o."gatewayFee"),0)::text AS fees, COALESCE(SUM(o."discountTotal"),0)::text AS discounts,
           COALESCE(SUM(cr."amount"),0)::text AS commission, COALESCE(SUM(cr."reversedAmount"),0)::text AS reversed
      FROM "Order" o JOIN "Event" e ON e."id" = o."eventId" LEFT JOIN "CommissionRecord" cr ON cr."orderId" = o."id"
     WHERE ${scope} AND o."status" IN ${PAID} AND o."paidAt" >= ${from} AND o."paidAt" <= ${to}`);
  const [ref] = await prisma.$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(r."amount"),0)::text AS refunded, COUNT(*)::int AS count
      FROM "Refund" r JOIN "Order" o ON o."id" = r."orderId" JOIN "Event" e ON e."id" = o."eventId"
     WHERE ${scope} AND r."status" = 'COMPLETED' AND r."completedAt" >= ${from} AND r."completedAt" <= ${to}`);
  const [tix] = await prisma.$queryRaw(Prisma.sql`
    SELECT COUNT(*)::int AS issued, COUNT(*) FILTER (WHERE t."status" = 'USED')::int AS used
      FROM "Ticket" t JOIN "Order" o ON o."id" = t."orderId" JOIN "Event" e ON e."id" = o."eventId"
     WHERE ${scope} AND o."paidAt" >= ${from} AND o."paidAt" <= ${to}`);
  const [pend] = await prisma.$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(o."total"),0)::text AS amount, COUNT(*)::int AS count
      FROM "Order" o JOIN "Event" e ON e."id" = o."eventId" WHERE ${scope} AND o."status" = 'PENDING' AND o."reservedUntil" > now()`);
  const gross = n(sales.gross);
  const commission = n(sales.commission) - n(sales.reversed);
  const refunds = n(ref.refunded);
  return {
    gross, refunds, commission, commissionGross: n(sales.commission), commissionReversed: n(sales.reversed), gatewayFees: n(sales.fees), discounts: n(sales.discounts),
    net: gross - refunds - commission, orders: sales.orders, avgOrder: sales.orders ? Math.round(gross / sales.orders) : 0,
    ticketsIssued: tix.issued, ticketsUsed: tix.used, refundCount: ref.count, refundRate: sales.orders ? ref.count / sales.orders : 0,
    pendingAmount: n(pend.amount), pendingOrders: pend.count,
  };
}

const fmtTotals = (t) => ({ ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, ['orders', 'ticketsIssued', 'ticketsUsed', 'refundCount', 'pendingOrders', 'refundRate'].includes(k) ? v : money(v)])) });

async function series({ organizerId, eventId, from, to }) {
  const scope = eventId ? Prisma.sql`o."eventId" = ${eventId}` : Prisma.sql`e."organizerId" = ${organizerId}`;
  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH paid AS (
      SELECT o."id", o."total", to_char(date_trunc('day', o."paidAt" AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day
        FROM "Order" o JOIN "Event" e ON e."id" = o."eventId"
       WHERE ${scope} AND o."status" IN ${PAID} AND o."paidAt" >= ${from} AND o."paidAt" <= ${to}
    ), tc AS (
      SELECT t."orderId", COUNT(*) AS c FROM "Ticket" t WHERE t."orderId" IN (SELECT "id" FROM paid) GROUP BY 1
    )
    SELECT paid.day, COALESCE(SUM(paid."total"),0)::text AS revenue, COUNT(*)::int AS orders, COALESCE(SUM(tc.c),0)::int AS tickets
      FROM paid LEFT JOIN tc ON tc."orderId" = paid."id" GROUP BY paid.day ORDER BY paid.day`);
  return rows.map((r) => ({ day: r.day, revenue: r.revenue, orders: r.orders, tickets: r.tickets }));
}

export async function organizerOverview(user, range) {
  const organizerId = user.organizer.id;
  const { from, to } = resolveRange(range);
  const [t, s, byStatus, remaining, balance, recentOrders, recentAttendees, upcoming] = await Promise.all([
    totals({ organizerId, from, to }),
    series({ organizerId, from, to }),
    prisma.event.groupBy({ by: ['status'], where: { organizerId }, _count: true }),
    prisma.$queryRaw(Prisma.sql`SELECT COALESCE(SUM(GREATEST(tt."quantityTotal" - tt."quantitySold" - tt."quantityReserved",0)),0)::int AS remaining
                                  FROM "TicketType" tt JOIN "Event" e ON e."id" = tt."eventId" WHERE e."organizerId" = ${organizerId} AND tt."active" AND e."status" IN ('PUBLISHED','SCHEDULED')`),
    organizerBalance(organizerId),
    prisma.order.findMany({ where: { event: { organizerId }, status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING'] } }, orderBy: { createdAt: 'desc' }, take: 8, select: { reference: true, buyerName: true, total: true, status: true, createdAt: true, event: { select: { title: true } } } }),
    prisma.ticket.findMany({ where: { event: { organizerId } }, orderBy: { createdAt: 'desc' }, take: 8, select: { holderName: true, number: true, createdAt: true, event: { select: { title: true } }, ticketType: { select: { name: true } } } }),
    prisma.event.findMany({ where: { organizerId, status: { in: ['DRAFT', 'PUBLISHED', 'SCHEDULED', 'UNPUBLISHED'] }, OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }, orderBy: { updatedAt: 'desc' }, take: 6, select: { id: true, title: true, status: true, startsAt: true, ticketsSold: true, ticketsRemaining: true } }),
  ]);
  const count = (st) => byStatus.find((x) => x.status === st)?._count ?? 0;
  return {
    range: { from, to },
    events: { published: count('PUBLISHED'), draft: count('DRAFT'), scheduled: count('SCHEDULED'), cancelled: count('CANCELLED'), total: byStatus.reduce((a, b) => a + b._count, 0) },
    totals: fmtTotals(t), ticketsRemaining: remaining[0].remaining, series: s,
    settlements: { pending: balance.formatted.pending, available: balance.formatted.available, requested: money(balance.settlementsRequested + balance.settlementsApproved), paidOut: balance.formatted.paidOut, earnedAllTime: balance.formatted.earned },
    recentOrders: recentOrders.map((o) => ({ ...o, total: o.total.toString() })), recentAttendees, upcoming,
    definitions: { gross: 'Paid orders by payment date', net: 'Gross - refunds - net commission. Not a bank balance.', pending: 'Funds still inside the refund-risk hold', paidOut: 'Settlements marked PAID' },
  };
}

export async function eventAnalytics(access, range) {
  const { from, to } = resolveRange({ ...range, preset: range.preset ?? undefined, from: range.from ?? new Date(0) });
  const eventId = access.event.id;
  const finance = access.can.finance;
  const [byType, checkin, bySource, hours, s, t] = await Promise.all([
    prisma.ticketType.findMany({ where: { eventId }, select: { id: true, name: true, price: true, quantityTotal: true, quantitySold: true, quantityReserved: true, active: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.ticket.groupBy({ by: ['status'], where: { eventId }, _count: true }),
    finance ? prisma.$queryRaw(Prisma.sql`SELECT COALESCE(o."referralSource", 'direct') AS source, COUNT(*)::int AS orders, COALESCE(SUM(o."total"),0)::text AS revenue FROM "Order" o WHERE o."eventId" = ${eventId} AND o."status" IN ${PAID} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`) : [],
    prisma.$queryRaw(Prisma.sql`SELECT EXTRACT(HOUR FROM o."paidAt" AT TIME ZONE ${TZ})::int AS hour, COUNT(*)::int AS orders FROM "Order" o WHERE o."eventId" = ${eventId} AND o."status" IN ${PAID} GROUP BY 1 ORDER BY 1`),
    series({ eventId, from, to }),
    totals({ eventId, from, to }),
  ]);
  const c = (st) => checkin.find((x) => x.status === st)?._count ?? 0;
  const issued = c('VALID') + c('USED');
  const base = {
    tickets: byType.map((x) => ({ id: x.id, name: x.name, price: x.price.toString(), total: x.quantityTotal, sold: x.quantitySold, reserved: x.quantityReserved, remaining: Math.max(0, x.quantityTotal - x.quantitySold - x.quantityReserved), active: x.active })),
    checkin: { admitted: c('USED'), valid: c('VALID'), rate: issued ? c('USED') / issued : 0 },
    peakHours: hours, series: s.map((r) => (finance ? r : { day: r.day, orders: r.orders, tickets: r.tickets })),
  };
  if (!finance) return base;
  return { ...base, totals: fmtTotals(t), bySource: bySource.map((r) => ({ source: r.source, orders: r.orders, revenue: r.revenue })) };
}

// ------------------------------------------------------------------ platform (admin)

export async function platformOverview(range) {
  const { from, to } = resolveRange(range);
  const [users, organizers, events, byStatus, tix, sales, refunds, failed, pendingLiab, settlements, activity] = await Promise.all([
    prisma.user.count(),
    prisma.organizerProfile.count(),
    prisma.event.count(),
    prisma.event.groupBy({ by: ['status'], _count: true }),
    prisma.ticket.count({ where: { status: { in: ['VALID', 'USED'] } } }),
    prisma.$queryRaw(Prisma.sql`
      SELECT COALESCE(SUM(o."total"),0)::text AS gross, COUNT(*)::int AS orders, COALESCE(SUM(cr."amount"),0)::text AS commission,
             COALESCE(SUM(cr."reversedAmount"),0)::text AS reversed, COALESCE(SUM(o."gatewayFee"),0)::text AS fees
        FROM "Order" o LEFT JOIN "CommissionRecord" cr ON cr."orderId" = o."id"
       WHERE o."status" IN ${PAID} AND o."paidAt" >= ${from} AND o."paidAt" <= ${to}`),
    prisma.$queryRaw(Prisma.sql`SELECT COALESCE(SUM("amount"),0)::text AS refunded FROM "Refund" WHERE "status" = 'COMPLETED' AND "completedAt" >= ${from} AND "completedAt" <= ${to}`),
    prisma.payment.count({ where: { status: { in: ['FAILED', 'UNDERPAID'] }, createdAt: { gte: from, lte: to } } }),
    prisma.$queryRaw(Prisma.sql`SELECT COALESCE(SUM("amount"),0)::text AS owed FROM "OrganizerLedgerEntry"`),
    prisma.settlement.groupBy({ by: ['status'], _sum: { amount: true }, _count: true }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 12, select: { id: true, action: true, entityType: true, entityId: true, actorRole: true, createdAt: true } }),
  ]);
  const st = (k) => byStatus.find((x) => x.status === k)?._count ?? 0;
  const sm = (k) => settlements.find((x) => x.status === k);
  const gross = n(sales[0].gross);
  const commissionNet = n(sales[0].commission) - n(sales[0].reversed);
  return {
    range: { from, to },
    counts: { users, organizers, events, published: st('PUBLISHED'), draft: st('DRAFT'), scheduled: st('SCHEDULED'), cancelled: st('CANCELLED'), suspended: st('SUSPENDED'), ticketsSold: tix, successfulTransactions: sales[0].orders, failedPayments: failed },
    recordedRevenue: { grossTicketSales: money(gross), refunds: money(n(refunds[0].refunded)), platformCommissionNet: money(commissionNet), gatewayFeesReported: money(n(sales[0].fees)) },
    liabilities: { owedToOrganizersLedger: money(n(pendingLiab[0].owed)), settlementsRequested: money(n(sm('REQUESTED')?._sum.amount)), settlementsApproved: money(n(sm('APPROVED')?._sum.amount)), settlementsPaid: money(n(sm('PAID')?._sum.amount)), settlementsCompletedCount: sm('PAID')?._count ?? 0 },
    notes: [
      'Recorded revenue and ledger balances are accounting figures derived from this app’s database.',
      'They are NOT verified bank or Bachs balances. Check your Bachs dashboard for the actual gateway balance.',
      'Owed to organizers excludes money already paid out (payouts are ledger debits).',
    ],
    recentActivity: activity,
  };
}

export async function platformSeries(range) {
  const { from, to } = resolveRange(range);
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT to_char(date_trunc('day', o."paidAt" AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day, COALESCE(SUM(o."total"),0)::text AS revenue,
           COALESCE(SUM(cr."amount" - cr."reversedAmount"),0)::text AS commission, COUNT(*)::int AS orders
      FROM "Order" o LEFT JOIN "CommissionRecord" cr ON cr."orderId" = o."id"
     WHERE o."status" IN ${PAID} AND o."paidAt" >= ${from} AND o."paidAt" <= ${to} GROUP BY 1 ORDER BY 1`);
  return rows;
}