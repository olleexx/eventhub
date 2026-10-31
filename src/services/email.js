// Transactional email outbox. Messages are inserted (ideally inside the business transaction), then
// delivered by processEmailQueue() with retries and exponential backoff. An SMTP outage can never
// roll back or corrupt a paid order, and webhook retries cannot duplicate a message because of
// the unique dedupeKey.
import { prisma, Prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { sendMail } from '../lib/mailer.js';
import { renderTemplate } from '../templates/emails.js';
import { getSettings } from './settings.js';

const MAX_ATTEMPTS = 6;

/**
 * @param client prisma or a transaction client
 * @returns true if queued, false if dedupeKey already existed (already queued/sent).
 * Uses ON CONFLICT DO NOTHING (skipDuplicates) because a caught unique-violation would abort the
 * surrounding Postgres transaction.
 */
export async function queueEmail(client, { to, template, data, dedupeKey }) {
  const settings = await getSettings();
  const payload = { platformName: settings.platformName, supportEmail: settings.supportEmail, ...data };
  const { subject } = renderTemplate(template, payload);
  const r = await client.emailDeliveryLog.createMany({
    data: [{ toEmail: to, subject, template, data: payload, dedupeKey: dedupeKey ?? null }],
    skipDuplicates: true,
  });
  return r.count > 0;
}

async function attachmentsFor(row) {
  if (row.template !== 'ticket_confirmation') return undefined;
  const { buildTicketsPdf, qrPng } = await import('./tickets.js');
  const order = await prisma.order.findUnique({
    where: { id: row.data.orderId },
    include: { event: true, tickets: { include: { ticketType: { select: { name: true } } }, orderBy: { createdAt: 'asc' } } },
  });
  if (!order) return undefined;
  const live = order.tickets.filter((t) => t.status === 'VALID' || t.status === 'USED');
  if (!live.length) return undefined;
  const pdf = await buildTicketsPdf({ tickets: live, event: order.event, order, platformName: row.data.platformName });
  const atts = [{ filename: `tickets-${order.reference}.pdf`, content: pdf, contentType: 'application/pdf' }];
  // Also attach QR PNGs for clients that preview images but not PDFs.
  for (let i = 0; i < live.length && i < 10; i++) {
    atts.push({ filename: `ticket-${live[i].number}.png`, content: await qrPng(live[i].code, 400), contentType: 'image/png' });
  }
  return atts;
}

async function deliver(row) {
  const { subject, html, text } = renderTemplate(row.template, row.data);
  const attachments = await attachmentsFor(row);
  await sendMail({ to: row.toEmail, subject, html, text, attachments });
}

/** Claim due messages (SKIP LOCKED => safe with several workers), then send. Returns counts. */
export async function processEmailQueue({ limit = 25 } = {}) {
  const claimed = await prisma.$queryRaw(Prisma.sql`
    UPDATE "EmailDeliveryLog"
       SET "attempts" = "attempts" + 1, "nextAttemptAt" = now() + interval '5 minutes'
     WHERE "id" IN (
       SELECT "id" FROM "EmailDeliveryLog"
        WHERE "status" IN ('PENDING','FAILED') AND "attempts" < ${MAX_ATTEMPTS} AND "nextAttemptAt" <= now()
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING "id"`);
  let sent = 0;
  let failed = 0;
  for (const { id } of claimed) {
    const row = await prisma.emailDeliveryLog.findUnique({ where: { id } });
    if (!row) continue;
    try {
      await deliver(row);
      await prisma.emailDeliveryLog.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
      sent++;
    } catch (err) {
      failed++;
      const backoffMin = Math.min(240, 2 ** row.attempts * 2);
      await prisma.emailDeliveryLog.update({
        where: { id },
        data: { status: 'FAILED', lastError: String(err?.message || err).slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMin * 60_000) },
      });
      log.warn('email_send_failed', { id, template: row.template, attempts: row.attempts, err });
    }
  }
  return { claimed: claimed.length, sent, failed };
}

/** Fire-and-forget attempt right after commit so users get mail quickly; the worker is the safety net. */
export function kickEmailQueue() {
  processEmailQueue({ limit: 10 }).catch((err) => log.warn('email_kick_failed', { err }));
}

export async function emailStats() {
  const rows = await prisma.emailDeliveryLog.groupBy({ by: ['status'], _count: true });
  return Object.fromEntries(rows.map((r) => [r.status, r._count]));
}

/** Admin: manually requeue permanently failed messages. */
export async function retryFailedEmails() {
  const r = await prisma.emailDeliveryLog.updateMany({ where: { status: 'FAILED' }, data: { attempts: 0, nextAttemptAt: new Date() } });
  return r.count;
}
