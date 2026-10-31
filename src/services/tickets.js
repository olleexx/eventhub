// Ticket rendering (QR + PDF) and ticket lookups. The QR encodes ONLY an opaque, high-entropy
// token ("EH1.<code>"): no names, no amounts, no payment claims. Admission always goes through
// the server (services/checkin.js).
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { prisma } from '../lib/prisma.js';
import { sha256, safeEqual } from '../utils/crypto.js';
import { notFound, forbidden } from '../lib/errors.js';

export const QR_PREFIX = 'EH1.';
export const qrPayload = (code) => `${QR_PREFIX}${code}`;

export function parseTicketInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  if (s.startsWith(QR_PREFIX)) return { code: s.slice(QR_PREFIX.length) };
  if (/^EH-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(s)) return { number: s.toUpperCase() };
  return { code: s }; // tolerate a bare token
}

export function qrPng(code, width = 360) {
  return QRCode.toBuffer(qrPayload(code), { type: 'png', width, margin: 1, errorCorrectionLevel: 'M' });
}

export function qrDataUrl(code, width = 320) {
  return QRCode.toDataURL(qrPayload(code), { width, margin: 1, errorCorrectionLevel: 'M' });
}

export function formatWhen(date, timeZone = 'Africa/Lagos') {
  if (!date) return 'Date to be announced';
  return new Intl.DateTimeFormat('en-NG', { dateStyle: 'full', timeStyle: 'short', timeZone }).format(date);
}

// pdfkit's built-in fonts only cover Latin-1: strip diacritics/unsupported glyphs rather than print garbage.
const pdfSafe = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e -ÿ]/g, '?');

/** Build one PDF with one page per ticket. */
export async function buildTicketsPdf({ tickets, event, order, platformName = 'EventHub' }) {
  const doc = new PDFDocument({ size: 'A5', margin: 34, info: { Title: `Tickets - ${pdfSafe(event.title)}`, Author: platformName } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (i > 0) doc.addPage();
    const w = doc.page.width - 68;
    doc.rect(0, 0, doc.page.width, 70).fill('#14122b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(pdfSafe(platformName), 34, 26);
    doc.fillColor('#14122b').font('Helvetica-Bold').fontSize(20).text(pdfSafe(event.title), 34, 92, { width: w });
    doc.moveDown(0.4).font('Helvetica').fontSize(11).fillColor('#555');
    doc.text(pdfSafe(formatWhen(event.startsAt, event.timezone)), { width: w });
    doc.text(pdfSafe([event.venueName, event.address, event.city].filter(Boolean).join(', ') || (event.onlineUrl ? 'Online event' : '')), { width: w });
    doc.moveDown(0.8).fillColor('#14122b').font('Helvetica-Bold').fontSize(13).text(pdfSafe(t.ticketType?.name || 'Ticket'));
    doc.font('Helvetica').fontSize(11).fillColor('#555').text(`Admit one${t.holderName ? ' - ' + pdfSafe(t.holderName) : ''}`);
    const png = await qrPng(t.code, 420);
    const qrSize = 190;
    doc.image(png, (doc.page.width - qrSize) / 2, doc.y + 14, { width: qrSize });
    doc.y += qrSize + 26;
    doc.fillColor('#14122b').font('Courier-Bold').fontSize(14).text(t.number, { align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#777').text(`Order ${order.reference}  |  Ticket ${i + 1} of ${tickets.length}`, { align: 'center' });
    if (event.entryInstructions) {
      doc.moveDown(0.8).fontSize(9).fillColor('#444').text(pdfSafe(event.entryInstructions).slice(0, 400), { width: w, align: 'left' });
    }
  }
  doc.end();
  return done;
}

export function tokenMatches(order, token) {
  if (!order.accessTokenHash || !token) return false;
  return safeEqual(order.accessTokenHash, sha256(token));
}

/**
 * Object-level access check for an order: the owning user, someone holding the emailed access
 * token, or a platform admin. Everyone else gets a 404 (does not reveal existence).
 */
export async function getOrderForViewer({ reference, token, user }, include = {}) {
  const order = await prisma.order.findUnique({
    where: { reference },
    include: {
      event: { select: { id: true, title: true, slug: true, startsAt: true, endsAt: true, timezone: true, venueName: true, address: true, city: true, onlineUrl: true, bannerUrl: true, entryInstructions: true, refundPolicy: true, refundDeadline: true, status: true, organizerId: true, currency: true } },
      items: { include: { ticketType: { select: { name: true } } } },
      tickets: { include: { ticketType: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      refunds: { orderBy: { createdAt: 'desc' } },
      ...include,
    },
  });
  if (!order) throw notFound('Order not found');
  const owner = user && order.userId && order.userId === user.id;
  const admin = user?.role === 'ADMIN';
  if (!owner && !admin && !tokenMatches(order, token)) throw notFound('Order not found');
  return order;
}

export async function listUserTickets(userId, email) {
  return prisma.ticket.findMany({
    where: { order: { OR: [{ userId }, { userId: null, buyerEmail: email }] }, status: { in: ['VALID', 'USED'] } },
    include: { event: { select: { title: true, slug: true, startsAt: true, venueName: true, city: true, bannerUrl: true, status: true } }, ticketType: { select: { name: true } }, order: { select: { reference: true } } },
    orderBy: { event: { startsAt: 'asc' } },
    take: 200,
  });
}

export { forbidden };
