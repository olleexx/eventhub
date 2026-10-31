// Email templates: each returns { subject, html, text }. Inline styles only (email clients).
import { config } from '../config/env.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const url = (p) => `${config.APP_URL.replace(/\/$/, '')}${p}`;

function layout({ name, title, bodyHtml, cta, footer }) {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${esc(cta.href)}" style="background:#ff5a4e;color:#fff;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:700;display:inline-block">${esc(cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#fff9f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14122b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" style="max-width:560px;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #f0e6da">
<tr><td style="background:#14122b;color:#fff;padding:18px 28px;font-weight:800;font-size:18px;letter-spacing:.3px">${esc(name)}</td></tr>
<tr><td style="padding:28px"><h1 style="font-size:22px;margin:0 0 14px">${esc(title)}</h1>${bodyHtml}${button}
<p style="color:#6b6880;font-size:12px;margin-top:28px">${footer || ''}</p></td></tr></table></td></tr></table></body></html>`;
}

const p = (s) => `<p style="line-height:1.55;margin:0 0 12px">${s}</p>`;

export const templates = {
  verify_email: (d) => ({
    subject: `Verify your email for ${d.platformName}`,
    html: layout({ name: d.platformName, title: 'Confirm your email', bodyHtml: p(`Hi ${esc(d.name)}, confirm your email address to finish setting up your account. This link expires in 24 hours.`), cta: { href: url(`/verify?token=${d.token}`), label: 'Verify email' } }),
    text: `Hi ${d.name},\n\nVerify your email: ${url(`/verify?token=${d.token}`)}\n(expires in 24 hours)`,
  }),

  password_reset: (d) => ({
    subject: `Reset your ${d.platformName} password`,
    html: layout({ name: d.platformName, title: 'Reset your password', bodyHtml: p('We received a request to reset your password. This link expires in 1 hour. If you did not ask for this, you can ignore this email.'), cta: { href: url(`/reset?token=${d.token}`), label: 'Choose a new password' } }),
    text: `Reset your password: ${url(`/reset?token=${d.token}`)}\n(expires in 1 hour). Ignore this email if it was not you.`,
  }),

  security_change: (d) => ({
    subject: `Security notice: ${d.what}`,
    html: layout({ name: d.platformName, title: 'Account security notice', bodyHtml: p(`${esc(d.what)} on ${esc(d.when)}. If this was not you, reset your password immediately and contact ${esc(d.supportEmail)}.`) }),
    text: `${d.what} on ${d.when}. If this was not you, reset your password and contact ${d.supportEmail}.`,
  }),

  organizer_welcome: (d) => ({
    subject: `Welcome to ${d.platformName} for organizers`,
    html: layout({ name: d.platformName, title: 'You can start selling tickets', bodyHtml: p(`Creating events is free. We only earn a commission when you sell tickets (${esc(d.commissionText)}).`), cta: { href: url('/organizer'), label: 'Open organizer dashboard' } }),
    text: `Creating events is free. We only earn a commission when you sell tickets (${d.commissionText}).\n${url('/organizer')}`,
  }),

  ticket_confirmation: (d) => ({
    subject: `Your tickets for ${d.eventTitle} (${d.reference})`,
    html: layout({
      name: d.platformName,
      title: "You're going! 🎉",
      bodyHtml:
        p(`Hi ${esc(d.buyerName)}, your payment for <strong>${esc(d.eventTitle)}</strong> was successful.`) +
        p(`<strong>When:</strong> ${esc(d.when)}<br><strong>Where:</strong> ${esc(d.where)}<br><strong>Order:</strong> ${esc(d.reference)}<br><strong>Total:</strong> ${esc(d.total)}`) +
        p(`${d.ticketCount} ticket${d.ticketCount === 1 ? '' : 's'} attached as a PDF. Show the QR code at the entrance. Each QR code admits one person, once.`),
      cta: { href: url(`/orders/${d.reference}?token=${d.accessToken}`), label: 'View tickets online' },
      footer: 'Keep this email private: anyone with the QR codes can use your tickets.',
    }),
    text: `Hi ${d.buyerName},\n\nYour tickets for ${d.eventTitle} are attached.\nWhen: ${d.when}\nWhere: ${d.where}\nOrder: ${d.reference}\nTotal: ${d.total}\n\nView online: ${url(`/orders/${d.reference}?token=${d.accessToken}`)}\nKeep this email private.`,
  }),

  payment_failed: (d) => ({
    subject: `Payment was not completed for ${d.eventTitle}`,
    html: layout({ name: d.platformName, title: 'Payment not completed', bodyHtml: p(`Your payment for <strong>${esc(d.eventTitle)}</strong> (order ${esc(d.reference)}) did not go through, so no tickets were issued and you have not been charged. ${esc(d.reason || '')}`), cta: { href: url(`/e/${d.eventSlug}`), label: 'Try again' } }),
    text: `Your payment for ${d.eventTitle} (order ${d.reference}) did not go through. No tickets were issued.\n${url(`/e/${d.eventSlug}`)}`,
  }),

  order_needs_review: (d) => ({
    subject: `We received your payment for ${d.eventTitle} and are reviewing it`,
    html: layout({ name: d.platformName, title: 'Your payment needs a quick review', bodyHtml: p(`We received your payment for order <strong>${esc(d.reference)}</strong>, but we could not issue tickets automatically (${esc(d.reason)}). You will receive either your tickets or a full refund — you do not need to pay again. Contact ${esc(d.supportEmail)} quoting the order reference if you have questions.`) }),
    text: `We received payment for order ${d.reference} but could not issue tickets automatically (${d.reason}). You will get tickets or a full refund. Contact ${d.supportEmail}.`,
  }),

  refund_status: (d) => ({
    subject: `Refund ${d.statusLabel} — ${d.eventTitle}`,
    html: layout({ name: d.platformName, title: `Refund ${d.statusLabel}`, bodyHtml: p(`Your refund of <strong>${esc(d.amount)}</strong> for order ${esc(d.reference)} is now <strong>${esc(d.statusLabel)}</strong>.${d.note ? ' ' + esc(d.note) : ''}`) + (d.statusLabel === 'completed' ? p('Your bank may take several business days to show the credit. Refunded tickets are no longer valid.') : '') }),
    text: `Your refund of ${d.amount} for order ${d.reference} is now ${d.statusLabel}. ${d.note || ''}`,
  }),

  event_update: (d) => ({
    subject: `Update: ${d.eventTitle}`,
    html: layout({ name: d.platformName, title: `Update for ${d.eventTitle}`, bodyHtml: p(esc(d.message)), cta: { href: url(`/e/${d.eventSlug}`), label: 'View event' } }),
    text: `Update for ${d.eventTitle}\n\n${d.message}\n${url(`/e/${d.eventSlug}`)}`,
  }),

  event_cancelled: (d) => ({
    subject: `Cancelled: ${d.eventTitle}`,
    html: layout({ name: d.platformName, title: 'This event was cancelled', bodyHtml: p(`${esc(d.eventTitle)} has been cancelled. ${d.paid ? 'A full refund of your order ' + esc(d.reference) + ' is being processed; we will email you when it completes.' : ''}`) + (d.reason ? p(esc(d.reason)) : '') }),
    text: `${d.eventTitle} has been cancelled. ${d.paid ? `A full refund of order ${d.reference} is being processed.` : ''} ${d.reason || ''}`,
  }),

  staff_invite: (d) => ({
    subject: `${d.inviterName} invited you to help with ${d.eventTitle}`,
    html: layout({ name: d.platformName, title: "You've been invited", bodyHtml: p(`${esc(d.inviterName)} invited you as <strong>${esc(d.roleLabel)}</strong> for <strong>${esc(d.eventTitle)}</strong>. Sign in (or create an account) with this email address to accept. The invitation expires in 7 days.`), cta: { href: url(`/staff/accept?token=${d.token}`), label: 'Accept invitation' } }),
    text: `${d.inviterName} invited you as ${d.roleLabel} for ${d.eventTitle}.\nAccept: ${url(`/staff/accept?token=${d.token}`)}\n(expires in 7 days)`,
  }),

  settlement_update: (d) => ({
    subject: `Payout ${d.statusLabel}: ${d.amount}`,
    html: layout({ name: d.platformName, title: `Payout ${d.statusLabel}`, bodyHtml: p(`A payout of <strong>${esc(d.amount)}</strong> is now <strong>${esc(d.statusLabel)}</strong>.${d.reference ? ' Bank reference: ' + esc(d.reference) + '.' : ''}`) }),
    text: `A payout of ${d.amount} is now ${d.statusLabel}. ${d.reference ? 'Reference: ' + d.reference : ''}`,
  }),

  waitlist_available: (d) => ({
    subject: `Tickets are available again: ${d.eventTitle}`,
    html: layout({ name: d.platformName, title: 'Good news — tickets are back', bodyHtml: p(`Tickets for <strong>${esc(d.eventTitle)}</strong> are available again. They go quickly, so grab yours now.`), cta: { href: url(`/e/${d.eventSlug}`), label: 'Get tickets' } }),
    text: `Tickets for ${d.eventTitle} are available again: ${url(`/e/${d.eventSlug}`)}`,
  }),

  support_reply: (d) => ({
    subject: `Re: ${d.subject}`,
    html: layout({ name: d.platformName, title: 'Reply from support', bodyHtml: p(esc(d.reply)) }),
    text: d.reply,
  }),

  test_email: (d) => ({
    subject: `${d.platformName} test email`,
    html: layout({ name: d.platformName, title: 'SMTP works', bodyHtml: p('This is a test message sent from the admin dashboard.') }),
    text: 'SMTP works.',
  }),
};

export function renderTemplate(name, data) {
  const t = templates[name];
  if (!t) throw new Error(`Unknown email template: ${name}`);
  return t(data);
}
