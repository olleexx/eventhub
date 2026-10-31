// Background tasks. Every task is idempotent and safe to run concurrently or repeatedly, so they work
// both from the in-process/standalone worker and from an external scheduler calling /internal/cron/:task.
import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { processEmailQueue, queueEmail, kickEmailQueue } from '../services/email.js';
import { expireDueOrders, reconcilePendingPayments, retryFailedWebhookEvents } from '../services/reconcile.js';
import { publishDueEvents, notifyWaitlists } from '../services/events.js';
import { processApprovedRefunds } from '../services/refunds.js';
import { purgeExpiredSessions } from '../middleware/session.js';
import { formatWhen } from '../services/tickets.js';

async function sendReminders() {
  const from = new Date(Date.now() + 20 * 3600_000);
  const to = new Date(Date.now() + 28 * 3600_000);
  const events = await prisma.event.findMany({ where: { status: 'PUBLISHED', startsAt: { gte: from, lte: to } }, select: { id: true, title: true, slug: true, startsAt: true, timezone: true, venueName: true, city: true } });
  let queued = 0;
  for (const e of events) {
    const orders = await prisma.order.findMany({ where: { eventId: e.id, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } }, select: { buyerEmail: true, user: { select: { notifyPrefs: true } } } });
    for (const o of orders) {
      if (o.user?.notifyPrefs?.reminders === false) continue;
      const ok = await queueEmail(prisma, { to: o.buyerEmail, template: 'event_update', data: { eventTitle: e.title, eventSlug: e.slug, message: `Reminder: ${e.title} starts ${formatWhen(e.startsAt, e.timezone)}${e.venueName ? ` at ${e.venueName}` : ''}. Bring your QR ticket.` }, dedupeKey: `reminder:${e.id}:${o.buyerEmail}` });
      if (ok) queued++;
    }
  }
  if (queued) kickEmailQueue();
  return { queued };
}

async function housekeeping() {
  const sessions = await purgeExpiredSessions();
  const tokens = await prisma.emailToken.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) } }, { usedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } }] } });
  const invites = await prisma.staffInvitation.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 30 * 86_400_000) }, acceptedAt: null } });
  // Retention: raw webhook payloads older than 90 days are reduced to a stub (hash + ids are kept for audit).
  const hooks = await prisma.paymentWebhookEvent.updateMany({ where: { receivedAt: { lt: new Date(Date.now() - 90 * 86_400_000) }, status: { in: ['PROCESSED', 'IGNORED'] }, NOT: { payload: { equals: {} } } }, data: { payload: {} } });
  const mails = await prisma.emailDeliveryLog.deleteMany({ where: { status: 'SENT', sentAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
  return { sessions, tokens: tokens.count, invites: invites.count, webhookPayloadsTrimmed: hooks.count, mailsPurged: mails.count };
}

export const TASKS = {
  'expire-orders': { everyMs: 60_000, run: () => expireDueOrders() },
  'publish-scheduled': { everyMs: 60_000, run: async () => ({ published: await publishDueEvents() }) },
  emails: { everyMs: 30_000, run: () => processEmailQueue({ limit: 50 }) },
  'process-refunds': { everyMs: 60_000, run: async () => ({ submitted: await processApprovedRefunds() }) },
  reconcile: { everyMs: 5 * 60_000, run: () => reconcilePendingPayments() },
  'retry-webhooks': { everyMs: 5 * 60_000, run: async () => ({ reprocessed: await retryFailedWebhookEvents() }) },
  waitlists: { everyMs: 5 * 60_000, run: async () => ({ notified: await notifyWaitlists() }) },
  reminders: { everyMs: 30 * 60_000, run: () => sendReminders() },
  housekeeping: { everyMs: 6 * 3600_000, run: () => housekeeping() },
};

export async function runTask(name) {
  const t = TASKS[name];
  const started = Date.now();
  try {
    const result = await t.run();
    log.info('task_done', { task: name, ms: Date.now() - started, result });
    return { task: name, ok: true, result };
  } catch (err) {
    log.error('task_failed', { task: name, err });
    return { task: name, ok: false, error: String(err.message).slice(0, 300) };
  }
}

export async function runAll() {
  const out = [];
  for (const name of Object.keys(TASKS)) out.push(await runTask(name));
  return out;
}
