import { boot, api, h, mount, state, money, fmtDate, statusBadge, eventCard, toast, toastError, formObj, formError, submitting, skeleton, empty, requireLogin, confirmDialog, loadMe } from '/js/core.js';

const main = await boot();
if (!requireLogin()) throw new Error('redirecting');
const u = state.user;
const panel = h('div', null, skeleton(2, 160));
const names = { tickets: 'My tickets', orders: 'Orders', saved: 'Saved', settings: 'Settings' };
let tab = location.hash.slice(1); if (!names[tab]) tab = 'tickets';
const tabs = h('div', { class: 'tabs', role: 'tablist' });
function renderTabs() { mount(tabs, ...Object.entries(names).map(([k, v]) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(k === tab), onclick: () => { tab = k; history.replaceState(null, '', `#${k}`); renderTabs(); show(); } }, v))); }
mount(main, h('div', { class: 'wrap section' }, h('h1', { style: { fontSize: 'var(--fs-4)' } }, `Hi ${u.name.split(' ')[0]}`), tabs, panel));
renderTabs();

async function show() {
  mount(panel, skeleton(2, 160));
  try { await ({ tickets, orders, saved, settings })[tab](); } catch (e) { mount(panel, empty('Could not load', e.message)); }
}
async function tickets() {
  const list = await api.get('/api/me/tickets');
  if (!list.length) return mount(panel, empty('No tickets yet', 'Tickets from paid orders appear here.', { href: '/events', label: 'Browse events' }));
  mount(panel, h('div', { class: 'grid g2' }, list.map((t) => h('article', { class: `ticket ${t.status !== 'VALID' ? 'used' : ''}`, style: { marginBottom: 0 }, 'data-status': t.status },
    h('div', { class: 'ticket-main' }, h('div', { class: 'row between' }, h('strong', null, t.type), statusBadge(t.status)), h('h4', { style: { margin: '6px 0' } }, h('a', { href: `/e/${t.event.slug}` }, t.event.title)), h('div', { class: 'small muted' }, fmtDate(t.event.startsAt)), h('div', { class: 'ticket-num small' }, t.number), h('a', { class: 'small', href: `/orders/${t.orderReference}` }, 'View order')),
    h('div', { class: 'ticket-qr' }, t.qr ? h('img', { src: t.qr, alt: `QR for ${t.number}`, width: 150, height: 150 }) : null)))));
}
async function orders() {
  const list = await api.get('/api/me/orders');
  if (!list.length) return mount(panel, empty('No orders yet'));
  mount(panel, h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Order', 'Date', 'Status', 'Total'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))), h('tbody', null, list.map((o) => h('tr', null, h('td', null, h('a', { href: `/orders/${o.reference}` }, o.reference)), h('td', null, fmtDate(o.createdAt)), h('td', null, statusBadge(o.status)), h('td', { class: 'num' }, Number(o.total) === 0 ? 'Free' : money(o.total, o.currency))))))));
}
async function saved() {
  const list = await api.get('/api/me/favorites');
  mount(panel, list.length ? h('div', { class: 'grid g4' }, list.map(eventCard)) : empty('Nothing saved', 'Tap “Save” on an event to find it here.'));
}
async function settings() {
  const f = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    try { await submitting(f.querySelector('button'), async () => { await api.patch('/api/auth/profile', { name: f.name.value, phone: f.phone.value, marketingConsent: f.marketingConsent.checked }); await loadMe(); toast('Saved', 'ok'); }); } catch (err) { formError(f, err); }
  } }, h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name'), h('input', { class: 'input', id: 'name', name: 'name', value: u.name })), h('div', { class: 'field' }, h('label', { for: 'phone' }, 'Phone'), h('input', { class: 'input', id: 'phone', name: 'phone', value: u.phone || '' })), h('label', { class: 'check field' }, h('input', { type: 'checkbox', name: 'marketingConsent', checked: Boolean(u.marketingConsent) }), 'Email me event recommendations'), h('button', { class: 'btn coral', type: 'submit' }, 'Save'));
  const pw = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    try { await submitting(pw.querySelector('button'), async () => { await api.post('/api/auth/change-password', { currentPassword: pw.currentPassword.value, newPassword: pw.newPassword.value }); pw.reset(); toast('Password changed', 'ok'); }); } catch (err) { formError(pw, err); }
  } }, h('div', { class: 'field' }, h('label', { for: 'cp' }, 'Current password'), h('input', { class: 'input', id: 'cp', name: 'currentPassword', type: 'password', autocomplete: 'current-password' })), h('div', { class: 'field' }, h('label', { for: 'np' }, 'New password (10+ characters)'), h('input', { class: 'input', id: 'np', name: 'newPassword', type: 'password', autocomplete: 'new-password' })), h('button', { class: 'btn', type: 'submit' }, 'Change password'));
  mount(panel, h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h3', null, 'Profile'), h('p', { class: 'muted small' }, u.email, u.emailVerified ? ' (verified)' : ' (not verified)'), f), h('div', { class: 'card' }, h('h3', null, 'Password'), pw)));
}
show();