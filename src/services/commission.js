// Commission engine (pure functions, no I/O).
//
// Rules (documented in docs/COMMISSION.md):
//  * Percentage is stored as a decimal percent (5 or 7.5). It is converted to basis points (bps) and
//    applied to the NET line amount (unit price * qty - discount) in integer minor units.
//  * Percentage part is rounded HALF UP to the nearest minor unit, per order line.
//  * An optional fixed fee per paid ticket is added. Free tickets (net line amount 0) never carry commission.
//  * Commission can never exceed the line amount.
//  * Refund reversal is proportional to the refunded share of the order total, rounded half up, and can
//    never exceed the commission that has not yet been reversed.
import { divRound } from '../lib/money.js';

export function percentToBps(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Commission percent must be between 0 and 100');
  return Math.round(n * 100);
}

export function calculateCommission({ lines, percent = 0, fixedMinorPerTicket = 0 }) {
  const bps = percentToBps(percent);
  if (!Number.isInteger(fixedMinorPerTicket) || fixedMinorPerTicket < 0) {
    throw new Error('fixedMinorPerTicket must be a non-negative integer');
  }
  let total = 0;
  const out = lines.map((l) => {
    const gross = l.unitMinor * l.quantity;
    const net = Math.max(0, gross - (l.discountMinor || 0));
    if (net === 0) return { net, commission: 0 };
    const pct = divRound(net * bps, 10000);
    const fixed = fixedMinorPerTicket * l.quantity;
    const commission = Math.min(net, pct + fixed);
    total += commission;
    return { net, commission };
  });
  return { lines: out, total };
}

export function commissionReversal({ orderTotalMinor, commissionMinor, alreadyReversedMinor = 0, refundMinor }) {
  if (orderTotalMinor <= 0) return 0;
  const share = divRound(commissionMinor * refundMinor, orderTotalMinor);
  return Math.max(0, Math.min(share, commissionMinor - alreadyReversedMinor));
}

// Effective rates for an event: event override wins, otherwise platform defaults.
export function effectiveRates(event, settings) {
  const percent = event?.commissionOverridePercent != null
    ? Number(event.commissionOverridePercent.toString())
    : Number(settings.commissionPercent);
  const fixedMinor = event?.commissionOverrideFixed != null
    ? Math.round(Number(event.commissionOverrideFixed.toString()) * 100)
    : Math.round(Number(settings.commissionFixedPerTicket) * 100);
  return { percent, fixedMinorPerTicket: fixedMinor };
}
