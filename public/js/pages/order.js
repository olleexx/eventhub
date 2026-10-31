import { boot, api, h, icon, mount, state, money, fmtDate, statusBadge, toast, toastError, promptDialog, skeleton, empty, params, download } from '/js/core.js';

const main = await boot();
const ref = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const p = params();
let token = p.get('token') || '';
try { if (!token) token = sessionStorage.getItem(`eh.tok.${ref}`) || ''; } catch { /* storage unavailable */ }
const tokenQ = token ? `token=${encodeURIComponent(token)}` : '';
const root = h('div', { class: 'wrap section' }, skeleton(2, 200));
mount(main, root);
let timer; let tries = 0;

async function load(first) {
  const returning = p.get('return') || p.get('checkout_id') ? 'return=1' : '';
  const q = [tokenQ, first && returning ? returning : returning && tries < 40 ? returning : ''].filter(Boolean).join('&');
  let o;
  try { o = await api.get(`/api/orders/${encodeURIComponent(ref)}${q ? `?${q}` : ''}`); }
  catch (e) { mount(root, empty('Order not found', 'Check the link in your email, or sign in to the account used for the purchase.', { href: '/login?next=' + encodeURIComponent(location.pathname), label: 'Sign in' })); return; }
  render(o);
  if (o.status === 'PENDING' && tries++ < 40) timer = setTimeout(() => load(false), 4000);
}

function render(o) {
  clearTimeout(o.status === 'PENDING' ? undefined : timer);
  const e = o.event;
  const tone = o.status === 'PAID' ? 'paid' : o.status === 'PENDING' ? 'pending' : o.status === 'REFUNDED' || o.status === 'PARTIALLY_REFUNDED' ? 'info' : 'bad';
  const mark = h('div', { class: `status-ico ${tone}`, 'aria-hidden': 'true' }, icon(tone === 'paid' ? 'check' : tone === 'pending' ? 'clock' : 'alert'));
  const head = {
    PAID: ['You are going!', 'Payment confirmed. Your tickets are below and have been emailed.'],
    PENDING: ['Confirming your payment…', 'This page updates automatically. Do not pay twice. If you completed payment, it can take a minute to confirm.'],
    CANCELLED: ['Order cancelled', 'This order was cancelled and no tickets were issued.'],
    EXPIRED: ['Order expired', 'The reservation time ran out before payment was confirmed. If you were charged, contact support with your order reference.'],
    FAILED: ['Payment failed', 'The payment did not go through. You have not been charged.'],
    NEEDS_REVIEW: ['Payment under review', 'We received a payment that needs a manual check. Our team will resolve this and email you. Keep your order reference.'],
    REFUNDED: ['Order refunded', 'This order has been fully refunded.'],
    PARTIALLY_REFUNDED: ['Order partly refunded', 'Some tickets on this order were refunded.'],
  }[o.status] || ['Order', ''];
  const tk = o.tickets.map((t) => h('article', { class: `ticket ${t.status !== 'VALID' ? 'used' : ''}`, 'data-status': t.status },
    h('div', { class: 'ticket-main' }, h('div', { class: 'row between' }, h('strong', null, t.type), statusBadge(t.status)), h('h3', { style: { margin: '6px 0' } }, e.title), h('div', { class: 'muted' }, fmtDate(e.startsAt, e.timezone)), h('div', { class: 'muted small' }, [e.venueName, e.city].filter(Boolean).join(', ')), t.holderName && h('div', null, t.holderName), h('div', { class: 'ticket-num', style: { marginTop: '10px' } }, t.number), t.checkedInAt && h('div', { class: 'small muted' }, `Checked in ${fmtDate(t.checkedInAt, e.timezone)}`)),
    h('div', { class: 'ticket-qr' }, t.qr ? h('img', { src: t.qr, alt: `QR code for ticket ${t.number}`, width: 180, height: 180 }) : h('span', { class: 'muted small' }, 'No QR'))));
  mount(root,
    h('div', { class: `card order-head ${tone}`, style: { marginBottom: '24px' } }, h('div', { class: 'row between' }, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, mark, h('h1', { style: { fontSize: 'var(--fs-4)', margin: 0 } }, head[0])), statusBadge(o.status)), h('p', { class: 'muted' }, head[1]), o.status === 'PENDING' && h('div', { class: 'spinner', role: 'status', 'aria-label': 'Checking payment' }),
      h('dl', { class: 'kv' }, h('dt', null, 'Order'), h('dd', null, o.reference), h('dt', null, 'Event'), h('dd', null, h('a', { href: `/e/${e.slug}` }, e.title)), h('dt', null, 'Total'), h('dd', null, o.total === '0' || Number(o.total) === 0 ? 'Free' : money(o.total, o.currency)), o.paidAt && [h('dt', null, 'Paid'), h('dd', null, fmtDate(o.paidAt))], Number(o.refundedTotal) > 0 && [h('dt', null, 'Refunded'), h('dd', null, money(o.refundedTotal, o.currency))])),
    o.tickets.some((t) => t.status === 'VALID' || t.status === 'USED') && h('div', { class: 'row', style: { marginBottom: '16px' } }, h('a', { class: 'btn coral', href: `/api/orders/${encodeURIComponent(ref)}/tickets.pdf${tokenQ ? `?${tokenQ}` : ''}` }, 'Download PDF tickets'), h('button', { class: 'btn ghost', type: 'button', onclick: () => window.print() }, 'Print')),
    o.tickets.length ? h('section', null, tk) : null,
    h('div', { class: 'card' }, h('h3', null, 'Order summary'), h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Ticket'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Total'))), h('tbody', null, o.items.map((i) => h('tr', null, h('td', null, i.name), h('td', { class: 'num' }, i.quantity), h('td', { class: 'num' }, money(i.unitPrice, o.currency)), h('td', { class: 'num' }, money(i.lineTotal, o.currency))))))),
      e.entryInstructions && h('p', { class: 'prose', style: { marginTop: '16px' } }, h('strong', null, 'Entry: '), e.entryInstructions)),
    o.refunds.length ? h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', null, 'Refunds'), o.refunds.map((r) => h('div', { class: 'row between' }, h('span', null, `${money(r.amount, o.currency)} · ${fmtDate(r.createdAt)}`), statusBadge(r.status)))) : null,
    o.canRequestRefund && h('p', { style: { marginTop: '16px' } }, h('button', { class: 'btn ghost', onclick: async () => {
      const reason = await promptDialog('Request a refund', { label: 'Tell the organizer why (min 5 characters)', multiline: true, confirmLabel: 'Request refund' });
      if (!reason) return;
      try { await api.post(`/api/orders/${encodeURIComponent(ref)}/refund-request${tokenQ ? `?${tokenQ}` : ''}`, { reason }); toast('Refund requested. The organizer will review it.', 'ok'); load(true); } catch (er) { toastError(er); }
    } }, 'Request a refund')),
    h('p', { class: 'small muted', style: { marginTop: '16px' } }, 'Keep this page link private: anyone with it can see these tickets. Need help? ', h('a', { href: '/contact' }, 'Contact support'), '.'));
}
load(true);