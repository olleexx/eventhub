import { api, h, mount, money, fmtDT, statusBadge, empty, toast, toastError, formError, submitting, state, loadMe } from '/js/core.js';

export async function financeView(root) {
  const d = await api.get('/api/organizer/finance');
  const b = d.balance; const c = state.settings.currency || 'NGN';
  const stat = (k, v, n) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, money(v, c) || '₦0'), n && h('div', { class: 'n' }, n));
  const pd = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    try { await submitting(pd.querySelector('button'), async () => { await api.put('/api/organizer/payout-details', { bankName: pd.bankName.value, accountName: pd.accountName.value, accountNumber: pd.accountNumber.value }); toast('Payout details saved', 'ok'); financeView(root); }); } catch (err) { formError(pd, err); }
  } }, h('div', { class: 'grid g3' },
    h('div', { class: 'field' }, h('label', null, 'Bank name'), h('input', { class: 'input', name: 'bankName', value: d.payoutDetails.bankName || '', required: true })),
    h('div', { class: 'field' }, h('label', null, 'Account name'), h('input', { class: 'input', name: 'accountName', value: d.payoutDetails.accountName || '', required: true })),
    h('div', { class: 'field' }, h('label', null, 'Account number (10 digits)'), h('input', { class: 'input', name: 'accountNumber', inputmode: 'numeric', maxlength: 10, placeholder: d.payoutDetails.accountLast4 ? `•••••• ${d.payoutDetails.accountLast4}` : '', required: true }))),
    h('button', { class: 'btn', type: 'submit' }, 'Save payout details'), h('p', { class: 'small muted' }, 'The account number is encrypted at rest. Only the last 4 digits are displayed.'));
  const rq = h('form', { novalidate: true, class: 'toolbar', onsubmit: async (e) => {
    e.preventDefault();
    try { await submitting(rq.querySelector('button'), async () => { await api.post('/api/organizer/settlements', { amount: rq.amount.value, note: rq.note.value || undefined }); toast('Payout requested. An admin will review it.', 'ok'); financeView(root); }); } catch (err) { formError(rq, err); }
  } }, h('div', { class: 'field' }, h('label', null, 'Amount (₦)'), h('input', { class: 'input', name: 'amount', type: 'number', min: 1, step: '0.01', required: true })), h('div', { class: 'field' }, h('label', null, 'Note (optional)'), h('input', { class: 'input', name: 'note', maxlength: 300 })), h('button', { class: 'btn coral', type: 'submit', disabled: !d.payoutDetails.accountLast4 }, 'Request payout'));
  mount(root, h('header', null, h('h1', null, 'Earnings & payouts')),
    h('div', { class: 'grid g4' }, stat('Available to request', b.available, 'Released after the refund-risk hold'), stat('Pending (on hold)', b.pending, 'Event not yet ended + hold days'), stat('Payout in progress', Number(b.settlementsRequested) + Number(b.settlementsApproved), 'Requested or approved'), stat('Paid out', b.paidOut, 'Marked paid by an admin')),
    h('p', { class: 'small muted' }, d.explanation),
    h('div', { class: 'grid g2', style: { marginTop: '16px' } }, h('div', { class: 'card' }, h('h3', null, 'Request a payout'), !d.payoutDetails.accountLast4 && h('p', { class: 'muted' }, 'Add payout details first.'), rq), h('div', { class: 'card' }, h('h3', null, 'Payout details'), d.payoutDetails.accountLast4 && h('p', { class: 'small' }, `${d.payoutDetails.bankName} · ${d.payoutDetails.accountName} · •••• ${d.payoutDetails.accountLast4}`), pd)),
    h('h3', { style: { marginTop: '24px' } }, 'Payout history'),
    d.settlements.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Requested', 'Amount', 'Status', 'Reference', 'Note'].map((x, i) => h('th', { class: i === 1 ? 'num' : '' }, x)))), h('tbody', null, d.settlements.map((s) => h('tr', null, h('td', null, fmtDT(s.createdAt)), h('td', { class: 'num' }, money(s.amount, s.currency)), h('td', null, statusBadge(s.status)), h('td', null, s.externalReference || '—'), h('td', { class: 'small muted' }, s.note || s.rejectionNote || '')))))) : empty('No payouts yet'));
}

export async function profileView(root) {
  const o = state.user.organizer;
  const f = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    try { await submitting(f.querySelector('button'), async () => { await api.patch('/api/organizer/profile', { brandName: f.brandName.value, bio: f.bio.value, website: f.website.value, supportEmail: f.supportEmail.value || null }); await loadMe(); toast('Saved', 'ok'); }); } catch (err) { formError(f, err); }
  } }, ...[['brandName', 'Brand name', 'text'], ['website', 'Website', 'url'], ['supportEmail', 'Support email shown to attendees', 'email']].map(([n, l, t]) => h('div', { class: 'field' }, h('label', null, l), h('input', { class: 'input', name: n, type: t }))), h('div', { class: 'field' }, h('label', null, 'About you'), h('textarea', { name: 'bio', maxlength: 1000 })), h('button', { class: 'btn coral', type: 'submit' }, 'Save profile'));
  f.brandName.value = o?.brandName || '';
  const logo = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'input', 'aria-label': 'Logo', onchange: async (e) => { const file = e.target.files[0]; if (!file) return; try { await api.upload('/api/organizer/profile/logo', file); await loadMe(); toast('Logo updated', 'ok'); profileView(root); } catch (er) { toastError(er); } } });
  mount(root, h('header', null, h('h1', null, 'Brand profile')), h('div', { class: 'grid g2' }, h('div', { class: 'card' }, f), h('div', { class: 'card' }, h('h3', null, 'Logo'), o?.logoUrl && h('img', { src: o.logoUrl, alt: 'Logo', width: 96, height: 96, style: { borderRadius: '50%', marginBottom: '12px', objectFit: 'cover' } }), logo)));
}
