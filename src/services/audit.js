import { prisma } from '../lib/prisma.js';

/**
 * Append an audit record. Pass a transaction client as the second argument to make the audit entry
 * atomic with the change it describes.
 */
export async function audit({ actor, action, entityType, entityId, eventId, before, after, ip }, client = prisma) {
  return client.auditLog.create({
    data: {
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? (actor ? 'USER' : 'SYSTEM'),
      action,
      entityType,
      entityId: entityId ?? null,
      eventId: eventId ?? null,
      before: before ?? undefined,
      after: after ?? undefined,
      ip: ip ?? null,
    },
  });
}
