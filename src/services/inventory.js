// Inventory concurrency control.
//
// Strategy: every change to TicketType counters is a single conditional UPDATE, so the database
// serialises competing buyers on the row lock and the WHERE clause is the oversell guard:
//     SET reserved = reserved + n  WHERE sold + reserved + n <= total
// Zero rows updated == sold out. A CHECK constraint (prisma/guards.sql) backs this up.
// No read-modify-write in application code, no reliance on isolation level.
import { Prisma } from '../lib/prisma.js';
import { conflict } from '../lib/errors.js';

export class CapacityError extends Error {
  constructor(ticketTypeId) {
    super('Not enough tickets available');
    this.ticketTypeId = ticketTypeId;
  }
}

/** Reserve capacity for all items (sorted by id to avoid deadlocks). Throws conflict on sell-out. */
export async function reserveItems(tx, items) {
  const sorted = [...items].sort((a, b) => (a.ticketTypeId < b.ticketTypeId ? -1 : 1));
  for (const it of sorted) {
    const n = await tx.$executeRaw(Prisma.sql`
      UPDATE "TicketType"
         SET "quantityReserved" = "quantityReserved" + ${it.quantity}
       WHERE "id" = ${it.ticketTypeId}
         AND "active" = true
         AND "quantitySold" + "quantityReserved" + ${it.quantity} <= "quantityTotal"`);
    if (n === 0) throw conflict(`Not enough tickets left for "${it.name || 'this ticket type'}"`, 'SOLD_OUT', { ticketTypeId: it.ticketTypeId });
  }
}

/**
 * Release the reservation held by a PENDING order exactly once. The flag flip is the idempotency
 * gate: duplicate expiry jobs / webhooks cannot release twice.
 * @returns {Promise<boolean>} true if this call released it
 */
export async function releaseOrderInventory(tx, orderId) {
  const flipped = await tx.order.updateMany({ where: { id: orderId, inventoryReleased: false }, data: { inventoryReleased: true } });
  if (flipped.count === 0) return false;
  const items = await tx.orderItem.findMany({ where: { orderId } });
  for (const it of items) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "TicketType"
         SET "quantityReserved" = GREATEST("quantityReserved" - ${it.quantity}, 0)
       WHERE "id" = ${it.ticketTypeId}`);
  }
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { discountCodeId: true, eventId: true } });
  if (order?.discountCodeId) {
    await tx.$executeRaw(Prisma.sql`UPDATE "DiscountCode" SET "usedCount" = GREATEST("usedCount" - 1, 0) WHERE "id" = ${order.discountCodeId}`);
  }
  if (order) await recalcEventStats(tx, order.eventId);
  return true;
}

/**
 * Convert an order's inventory to SOLD when payment is verified.
 *  - reservation still held  -> reserved -= n, sold += n
 *  - reservation was released (payment arrived after expiry) -> try to claim fresh capacity;
 *    throws CapacityError if the event can no longer honour the order (caller marks NEEDS_REVIEW + refund).
 */
export async function commitOrderInventory(tx, order, items) {
  const late = order.inventoryReleased;
  for (const it of [...items].sort((a, b) => (a.ticketTypeId < b.ticketTypeId ? -1 : 1))) {
    const n = late
      ? await tx.$executeRaw(Prisma.sql`
          UPDATE "TicketType" SET "quantitySold" = "quantitySold" + ${it.quantity}
           WHERE "id" = ${it.ticketTypeId} AND "quantitySold" + "quantityReserved" + ${it.quantity} <= "quantityTotal"`)
      : await tx.$executeRaw(Prisma.sql`
          UPDATE "TicketType" SET "quantityReserved" = "quantityReserved" - ${it.quantity}, "quantitySold" = "quantitySold" + ${it.quantity}
           WHERE "id" = ${it.ticketTypeId} AND "quantityReserved" >= ${it.quantity}`);
    if (n === 0) throw new CapacityError(it.ticketTypeId);
  }
  if (late) {
    // Capacity is now held as SOLD; restore the flag so nothing releases it again, and re-take the discount use.
    await tx.order.update({ where: { id: order.id }, data: { inventoryReleased: false } });
    if (order.discountCodeId) await tx.$executeRaw(Prisma.sql`UPDATE "DiscountCode" SET "usedCount" = "usedCount" + 1 WHERE "id" = ${order.discountCodeId}`);
  }
  return { late };
}

/** Refresh denormalised listing stats on Event (min price, sold, remaining). */
export async function recalcEventStats(tx, eventId) {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "Event" e SET
      "minPrice" = s.minp,
      "ticketsSold" = s.sold,
      "ticketsRemaining" = s.rem
    FROM (
      SELECT MIN(CASE WHEN "visible" AND "active" THEN "price" END) AS minp,
             COALESCE(SUM("quantitySold"), 0)::int AS sold,
             COALESCE(SUM(CASE WHEN "visible" AND "active" THEN GREATEST("quantityTotal" - "quantitySold" - "quantityReserved", 0) ELSE 0 END), 0)::int AS rem
        FROM "TicketType" WHERE "eventId" = ${eventId}
    ) s
    WHERE e."id" = ${eventId}`);
}
