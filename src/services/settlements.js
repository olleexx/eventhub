// Organizer settlements (payouts).
//
// The platform does not assume Bachs can split payments or pay organizers automatically (the SDK
// advertises connected accounts/withdrawals but that was not verified). So payouts are a controlled
// MANUAL workflow with a full audit trail:
//   organizer/admin REQUESTS  -> funds are reserved immediately by a PAYOUT ledger debit
//   admin APPROVES            -> still not paid
//   admin pays outside the app (bank/Bachs dashboard) and records PAID with the bank reference
//   REJECT / cancel           -> reversing ADJUSTMENT credit (the original debit is never edited)
// A balance is never described as paid until status = PAID.
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { toMinor, fromMinor, formatMoney } from '../lib/money.js';
import { organizerBalance, postEntries, lockOrganizer } from './ledger.js';
import { queueEmail, kickEmailQueue } from './email.js';
import { audit } from './audit.js';

const MIN_PAYOUT_MINOR = 100_000; // NGN 1,000.00

export async function requestSettlement({ actor, organizerId, amount, note, currency = 'NGN' }) {
  const minor = toMinor(String(amount));
  if (minor < MIN_PAYOUT_MINOR) throw badRequest(`Minimum payout is ${formatMoney(fromMinor(MIN_PAYOUT_MINOR), currency)}`);
  const settlement = await prisma.$transaction(async (tx) => {
    await lockOrganizer(tx, organizerId);
    const org = await tx.organizerProfile.findUnique({ where: { id: organizerId }, include: { user: true } });
    if (!org || org.suspended) throw forbidden('This organizer cannot request payouts');
    if (!org.payoutAccountName || !org.payoutAccountEnc) throw badRequest('Add your payout bank details first', undefined, 'PAYOUT_DETAILS_MISSING');
    const bal = await organizerBalance(organizerId, tx);
    if (minor > bal.available) throw conflict(`Only ${formatMoney(fromMinor(Math.max(bal.available, 0)), currency)} is available to withdraw right now. Funds are released after the event plus the refund-risk hold.`, 'INSUFFICIENT_AVAILABLE');
    const s = await tx.settlement.create({ data: { organizerId, amount: fromMinor(minor), currency, status: 'REQUESTED', note: note ?? null, requestedById: actor.id } });
    await postEntries(tx, [{ organizerId, type: 'PAYOUT', amount: fromMinor(-minor), currency, settlementId: s.id, availableAt: new Date(), idempotencyKey: `settle:${s.id}`, memo: 'Payout requested (funds reserved)' }]);
    await audit({ actor, action: 'settlement.request', entityType: 'Settlement', entityId: s.id, after: { amount: fromMinor(minor), organizerId } }, tx);
    return s;
  });
  return settlement;
}

async function loadSettlement(id) {
  const s = await prisma.settlement.findUnique({ where: { id }, include: { organizer: { include: { user: true } } } });
  if (!s) throw notFound('Settlement not found');
  return s;
}

export async function approveSettlement(admin, id) {
  const s = await loadSettlement(id);
  const r = await prisma.settlement.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'APPROVED', approvedById: admin.id } });
  if (r.count === 0) throw conflict(`Settlement is ${s.status.toLowerCase()}, not awaiting approval`);
  await audit({ actor: admin, action: 'settlement.approve', entityType: 'Settlement', entityId: id });
  return prisma.settlement.findUnique({ where: { id } });
}

export async function rejectSettlement(admin, id, note) {
  const s = await loadSettlement(id);
  await prisma.$transaction(async (tx) => {
    const r = await tx.settlement.updateMany({ where: { id, status: { in: ['REQUESTED', 'APPROVED'] } }, data: { status: 'REJECTED', note: note ?? s.note } });
    if (r.count === 0) throw conflict(`Settlement is ${s.status.toLowerCase()} and can no longer be rejected`);
    await postEntries(tx, [{ organizerId: s.organizerId, type: 'ADJUSTMENT', amount: s.amount.toString(), currency: s.currency, settlementId: id, availableAt: new Date(), idempotencyKey: `settle-reversal:${id}`, memo: `Payout rejected, funds released${note ? `: ${note}` : ''}` }]);
    await queueEmail(tx, { to: s.organizer.user.email, template: 'settlement_update', data: { statusLabel: 'rejected', amount: formatMoney(s.amount.toString(), s.currency), reference: note ?? '' }, dedupeKey: `settlement-rejected:${id}` });
    await audit({ actor: admin, action: 'settlement.reject', entityType: 'Settlement', entityId: id, after: { note } }, tx);
  });
  kickEmailQueue();
}

export async function markSettlementPaid(admin, id, externalReference) {
  const s = await loadSettlement(id);
  if (s.approvedById && s.approvedById === admin.id && s.requestedById === admin.id) {
    // Four-eyes principle where practical: the person who requested must not also approve and pay.
    throw forbidden('A different administrator must approve and pay a payout that you requested', 'FOUR_EYES');
  }
  await prisma.$transaction(async (tx) => {
    const r = await tx.settlement.updateMany({ where: { id, status: 'APPROVED' }, data: { status: 'PAID', paidAt: new Date(), paidById: admin.id, externalReference } });
    if (r.count === 0) throw conflict('Only approved settlements can be marked paid');
    await queueEmail(tx, { to: s.organizer.user.email, template: 'settlement_update', data: { statusLabel: 'paid', amount: formatMoney(s.amount.toString(), s.currency), reference: externalReference }, dedupeKey: `settlement-paid:${id}` });
    await audit({ actor: admin, action: 'settlement.paid', entityType: 'Settlement', entityId: id, after: { externalReference } }, tx);
  });
  kickEmailQueue();
}

export async function listSettlements({ organizerId, status, page = 1, pageSize = 20 }) {
  const where = { ...(organizerId ? { organizerId } : {}), ...(status ? { status } : {}) };
  const [total, items] = await Promise.all([
    prisma.settlement.count({ where }),
    prisma.settlement.findMany({ where, include: { organizer: { select: { brandName: true, payoutBankName: true, payoutAccountName: true, payoutAccountLast4: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { total, items: items.map((s) => ({ ...s, amount: s.amount.toString() })) };
}
