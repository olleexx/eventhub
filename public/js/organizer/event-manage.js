import { api, h, mount, money, num, fmtDT, fmtDate, statusBadge, empty, pager, qs, toast, toastError, confirmDialog, promptDialog, modal, formError, submitting, download, state, skeleton, fromInputDT } from '/js/core.js';
import { chart, fillDays } from '/js/charts.js';

const TABS = [['overview', 'Overview'], ['attendees', 'Attendees'], ['orders', 'Orders'], ['discounts', 'Discounts'], ['staff', 'Staff'], ['activity', 'Activity'], ['actions', 'Event actions']];

export async function eventManage(root, id, tab = 'overview') {
  if (!TABS.some(([k]) => k === tab)) tab = 'overview';
  const { event: ev, ticketTypes, discounts, permissions: can } = await api.get(`/api/organizer/events/${id}`);
  const body = h('div', null, skeleton(2, 140));
  const tabs = TABS.filter(([k]) => ({ orders: can.finance, discounts: can.finance, staff: can.staff, activity: can.staff, attendees: can.attendees, actions: can.publish || can.manage }[k] ?? true));
  mount(root,
    h('header', null, h('div', null, h('h1', null, ev.title), h('div', { class: 'row' }, statusBadge(ev.status), h('span', { class: 'muted small' }, fmtDT(ev.startsAt)))), h('div', { class: 'row' }, can.manage && h('a', { class: 'btn ghost', href: `#/events/${id}/edit` }, 'Edit'), can.scan && h('a', { class: 'btn ghost', href: `/scan?event=${id}` }, 'Scan tickets'), ['PUBLISHED', 'CANCELLED'].includes(ev.status) && h('a', { class: 'btn ghost', href: `/e/${ev.slug}`, target: '_blank', rel: 'noopener' }, 'Public page ↗'))),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('a', { class: 'tab', role: 'tab', 'aria-selected': String(k === tab), href: `#/events/${id}/${k}`, style: { textDecoration: 'none' } }, label))), body);
  const views = { overview, attendees, orders, discounts: discountsView, staff: staffView, activity, actions };
  await views[tab](body, { id, ev, ticketTypes, discounts, can });
}

async function overview(body, { id, ev, can }) {
  const a = await api.get(`/api/organizer/events/${id}/analytics?preset=custom`);
  const c = ev.currency; const t = a.totals;
  const stat = (k, v, n) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), n && h('div', { class: 'n' }, n));
  const from = a.series[0]?.day ?? new Date().toISOString().slice(0, 10); const to = new Date().toISOString().slice(0, 10);
  mount(body,
    h('div', { class: 'grid g4' }, t ? [stat('Gross sales', money(t.gross, c) || '₦0', `${num(t.orders)} orders`), stat('Net earnings', money(t.net, c) || '₦0', 'After refunds & commission'), stat('Commission', money(t.commission, c) || '₦0'), stat('Refunds', money(t.refunds, c) || '₦0', `${num(t.refundCount)} refunds`)] : null,
      stat('Checked in', `${num(a.checkin.admitted)} / ${num(a.checkin.admitted + a.checkin.valid)}`, `${Math.round(a.checkin.rate * 100)}% attendance`), stat('Tickets left', num(a.tickets.reduce((s, x) => s + x.remaining, 0)))),
    h('div', { class: 'grid g2', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('h3', null, t ? 'Revenue per day' : 'Tickets per day'), chart(fillDays(a.series, t ? 'revenue' : 'tickets', from, to), { label: 'Sales per day', fmt: (v) => (t ? money(v, c) || '₦0' : String(v)) })),
      h('div', { class: 'card' }, h('h3', null, 'Ticket types'), h('div', { class: 'stack' }, a.tickets.map((x) => h('div', null, h('div', { class: 'row between' }, h('strong', null, x.name), h('span', { class: 'small muted' }, `${num(x.sold)} sold · ${num(x.reserved)} held · ${num(x.remaining)} left of ${num(x.total)}`)), h('div', { class: 'bar' }, h('i', { style: { width: `${x.total ? Math.min(100, (x.sold / x.total) * 100) : 0}%` } }))))))),
    h('div', { class: 'grid g2', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('h3', null, 'Peak purchase hours (Lagos)'), chart(Array.from({ length: 24 }, (_, hr) => ({ label: String(hr).padStart(2, '0'), value: a.peakHours.find((p) => p.hour === hr)?.orders ?? 0 })), { kind: 'bar', color: 'var(--violet)', label: 'Orders by hour', height: 180 })),
      t && h('div', { class: 'card' }, h('h3', null, 'Sales by source'), a.bySource.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Source'), h('th', { class: 'num' }, 'Orders'), h('th', { class: 'num' }, 'Revenue'))), h('tbody', null, a.bySource.map((s) => h('tr', null, h('td', null, s.source), h('td', { class: 'num' }, s.orders), h('td', { class: 'num' }, money(s.revenue, c) || '₦0')))))) : h('p', { class: 'muted' }, 'No sales yet. Share your link with ?ref=name to track sources.'))),
    t && h('p', { class: 'small muted' }, 'Figures come from paid orders in the database. Net earnings is an accounting figure, not a bank balance.'));
}

async function attendees(body, { id, ev }) {
  const q = { q: '', checkedIn: '', page: 1 };
  const list = h('div', null);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search name, email or ticket no.', 'aria-label': 'Search attendees', oninput: (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 300); }; })() });
  const st = h('select', { 'aria-label': 'Check-in status', onchange: (e) => { q.checkedIn = e.target.value; q.page = 1; load(); } }, [['', 'All'], ['yes', 'Checked in'], ['no', 'Not checked in']].map(([v, t]) => h('option', { value: v }, t)));
  mount(body, h('div', { class: 'toolbar' }, search, st, h('a', { class: 'btn ghost', href: `/api/organizer/events/${id}/attendees.csv${qs({ q: q.q, checkedIn: q.checkedIn })}`, onclick: (e) => { e.currentTarget.href = `/api/organizer/events/${id}/attendees.csv${qs({ q: q.q, checkedIn: q.checkedIn })}`; } }, 'Export CSV')), list);
  async function load() {
    const r = await api.getFull(`/api/organizer/events/${id}/attendees${qs({ ...q, pageSize: 25 })}`);
    mount(list, r.data.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Ticket', 'Name', 'Email', 'Type', 'Order', 'Status'].map((x) => h('th', null, x)))), h('tbody', null, r.data.map((t) => h('tr', null, h('td', null, t.number), h('td', null, t.name || '—'), h('td', null, t.email || '—'), h('td', null, t.ticketType), h('td', null, t.orderReference), h('td', null, t.checkedInAt ? h('span', { class: 'badge ok' }, `In ${fmtDT(t.checkedInAt)}`) : statusBadge(t.status))))))) : empty('No attendees match'), pager(r.meta, (n) => { q.page = n; load(); }));
  }
  await load();
}

async function orders(body, { id }) {
  const q = { q: '', status: '', page: 1, eventId: id };
  const list = h('div', null);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search order, name or email', 'aria-label': 'Search orders', oninput: (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 300); }; })() });
  mount(body, h('div', { class: 'toolbar' }, search, h('a', { class: 'btn ghost', href: `/api/organizer/orders.csv${qs({ eventId: id })}` }, 'Export CSV')), list);
  async function load() { const r = await api.getFull(`/api/organizer/orders${qs({ ...q, pageSize: 25 })}`); mount(list, orderTable(r.data), pager(r.meta, (n) => { q.page = n; load(); })); }
  await load();
}
export function orderTable(rows, onChange) {
  if (!rows.length) return empty('No orders yet');
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Order', 'Customer', 'Tickets', 'Total', 'Commission', 'Net', 'Status', 'Date', ''].map((x, i) => h('th', { class: [3, 4, 5].includes(i) ? 'num' : '' }, x)))),
    h('tbody', null, rows.map((o) => h('tr', null, h('td', null, h('strong', null, o.reference), o.eventTitle && h('div', { class: 'small muted' }, o.eventTitle)), h('td', null, o.customerName, h('div', { class: 'small muted' }, o.customerEmail)), h('td', null, o.tickets), h('td', { class: 'num' }, Number(o.total) === 0 ? 'Free' : money(o.total, o.currency)), h('td', { class: 'num' }, o.commission != null ? money(o.commission, o.currency) || '₦0' : '—'), h('td', { class: 'num' }, o.organizerNet != null ? money(o.organizerNet, o.currency) || '₦0' : '—'), h('td', null, statusBadge(o.status), o.refundStatus && h('div', { class: 'small muted' }, `refund ${o.refundStatus.toLowerCase()}`)), h('td', null, fmtDT(o.purchasedAt)), h('td', null, h('button', { class: 'btn ghost sm', onclick: () => orderModal(o.reference, onChange) }, 'Open')))))));
}
export async function orderModal(reference, onChange) {
  let o; try { o = await api.get(`/api/organizer/orders/${encodeURIComponent(reference)}`); } catch (e) { return toastError(e); }
  const canRefund = ['PAID', 'PARTIALLY_REFUNDED'].includes(o.status);
  modal({ title: `Order ${o.reference}`, body: h('div', null,
    h('dl', { class: 'kv' }, h('dt', null, 'Buyer'), h('dd', null, `${o.buyerName} · ${o.buyerEmail}`), h('dt', null, 'Status'), h('dd', null, statusBadge(o.status)), h('dt', null, 'Total'), h('dd', null, money(o.total, o.currency) || 'Free'), h('dt', null, 'Commission'), h('dd', null, money(o.commissionTotal, o.currency) || '₦0'), h('dt', null, 'Refunded'), h('dd', null, money(o.refundedTotal, o.currency) || '₦0'), h('dt', null, 'Payments'), h('dd', null, o.payments.map((p) => `${p.status}${p.lastGatewayStatus ? ` (${p.lastGatewayStatus})` : ''}`).join(', ') || '—')),
    h('h4', { style: { marginTop: '12px' } }, 'Tickets'), h('ul', null, o.tickets.map((t) => h('li', null, `${t.number} · ${t.ticketType.name} · ${t.status.toLowerCase()}`))),
    o.refunds.length ? [h('h4', null, 'Refunds'), h('ul', null, o.refunds.map((r) => h('li', null, `${money(r.amount, o.currency)} · ${r.status.toLowerCase().replace(/_/g, ' ')}`)))] : null),
    actions: [{ label: 'Close', class: 'ghost' },
      ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(o.status) && { label: 'Resend tickets', class: 'ghost', close: false, onClick: async () => { try { await api.post(`/api/organizer/orders/${o.reference}/resend`); toast('Tickets queued for email', 'ok'); } catch (e) { toastError(e); } } },
      canRefund && { label: 'Refund order', class: 'danger', onClick: async ({ close }) => { const reason = await promptDialog('Refund this order', { label: 'Reason (the buyer is emailed)', multiline: true, confirmLabel: 'Refund in full' }); if (!reason) return; try { await api.post(`/api/organizer/orders/${o.reference}/refund`, { reason }); toast('Refund started. It completes when the payment provider confirms it.', 'ok'); close(); onChange?.(); } catch (e) { toastError(e); } } }].filter(Boolean) });
}

async function discountsView(body, { id, discounts, ev }) {
  const f = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const pct = f.percentOff.value, amt = f.amountOff.value;
    const b = { code: f.code.value, percentOff: pct ? Number(pct) : null, amountOff: amt || null, maxUses: f.maxUses.value ? Number(f.maxUses.value) : null, expiresAt: f.expiresAt.value ? fromInputDT(f.expiresAt.value, ev.timezone) : null };
    try { await submitting(f.querySelector('button'), async () => { await api.post(`/api/organizer/events/${id}/discounts`, b); toast('Code created', 'ok'); eventManage(body.closest('.content'), id, 'discounts'); }); } catch (err) { formError(f, err); }
  } }, h('div', { class: 'grid g4' }, ...[['code', 'Code'], ['percentOff', '% off'], ['amountOff', '₦ off'], ['maxUses', 'Max uses']].map(([n, l]) => h('div', { class: 'field' }, h('label', null, l), h('input', { class: 'input', name: n, type: n === 'code' ? 'text' : 'number', min: 0, step: n === 'amountOff' ? '0.01' : '1' }))), h('div', { class: 'field' }, h('label', null, 'Expires'), h('input', { class: 'input', name: 'expiresAt', type: 'datetime-local' }))), h('button', { class: 'btn coral sm', type: 'submit' }, 'Create code'));
  mount(body, h('div', { class: 'card' }, h('h3', null, 'New discount code'), h('p', { class: 'small muted' }, 'Set either a percentage or a fixed amount. Discounts reduce the ticket price; commission is calculated on the discounted price.'), f),
    h('div', { class: 'table-wrap', style: { marginTop: '16px' } }, discounts.length ? h('table', null, h('thead', null, h('tr', null, ['Code', 'Discount', 'Used', 'Expires', 'Active'].map((x) => h('th', null, x)))), h('tbody', null, discounts.map((d) => h('tr', null, h('td', null, d.code), h('td', null, d.percentOff ? `${d.percentOff}%` : money(d.amountOff, ev.currency)), h('td', null, `${d.usedCount}${d.maxUses ? ` / ${d.maxUses}` : ''}`), h('td', null, d.expiresAt ? fmtDT(d.expiresAt) : 'Never'), h('td', null, h('input', { type: 'checkbox', checked: d.active, 'aria-label': `Toggle ${d.code}`, onchange: async (e) => { try { await api.patch(`/api/organizer/events/${id}/discounts/${d.id}`, { active: e.target.checked }); } catch (er) { e.target.checked = !e.target.checked; toastError(er); } } })))))) : empty('No discount codes')));
}

async function staffView(body, { id }) {
  const s = await api.get(`/api/organizer/events/${id}/staff`);
  const f = h('form', { novalidate: true, class: 'toolbar', onsubmit: async (e) => {
    e.preventDefault();
    try { await submitting(f.querySelector('button'), async () => { await api.post(`/api/organizer/events/${id}/staff`, { email: f.email.value, role: f.role.value }); toast('Invitation sent', 'ok'); eventManage(body.closest('.content'), id, 'staff'); }); } catch (err) { formError(f, err); }
  } }, h('div', { class: 'field' }, h('label', null, 'Email'), h('input', { class: 'input', name: 'email', type: 'email', required: true })), h('div', { class: 'field' }, h('label', null, 'Role'), h('select', { name: 'role' }, [['SCANNER', 'Scanner (check-in only)'], ['ATTENDEE_VIEWER', 'Attendee viewer'], ['MANAGER', 'Manager (edit event, no finances)']].map(([v, t]) => h('option', { value: v }, t)))), h('button', { class: 'btn coral', type: 'submit' }, 'Invite'));
  const rm = (fn) => async () => { try { await fn(); toast('Removed', 'ok'); eventManage(body.closest('.content'), id, 'staff'); } catch (e) { toastError(e); } };
  mount(body, h('div', { class: 'card' }, h('h3', null, 'Invite staff'), f),
    h('div', { class: 'table-wrap', style: { marginTop: '16px' } }, h('table', null, h('thead', null, h('tr', null, ['Person', 'Role', 'Status', ''].map((x) => h('th', null, x)))), h('tbody', null,
      s.staff.map((p) => h('tr', null, h('td', null, `${p.name} (${p.email})`), h('td', null, p.role), h('td', null, h('span', { class: 'badge ok' }, 'active')), h('td', null, h('button', { class: 'btn ghost sm', onclick: rm(() => api.del(`/api/organizer/events/${id}/staff/${p.id}`)) }, 'Remove')))),
      s.invites.map((p) => h('tr', null, h('td', null, p.email), h('td', null, p.role), h('td', null, h('span', { class: 'badge warn' }, `invited, expires ${fmtDT(p.expiresAt)}`)), h('td', null, h('button', { class: 'btn ghost sm', onclick: rm(() => api.del(`/api/organizer/events/${id}/invitations/${p.id}`)) }, 'Revoke'))))))));
}

async function activity(body, { id }) {
  const rows = await api.get(`/api/organizer/events/${id}/activity`);
  mount(body, rows.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Action', 'Role', 'Details'].map((x) => h('th', null, x)))), h('tbody', null, rows.map((r) => h('tr', null, h('td', null, fmtDT(r.createdAt)), h('td', null, r.action), h('td', null, r.actorRole), h('td', { class: 'small muted' }, JSON.stringify(r.after ?? '').slice(0, 120))))))) : empty('No activity recorded yet'));
}

async function actions(body, { id, ev, can }) {
  const redo = () => eventManage(body.closest('.content'), id, 'actions');
  const act = (label, desc, cls, fn) => h('div', { class: 'card row between' }, h('div', null, h('strong', null, label), h('div', { class: 'small muted' }, desc)), h('button', { class: `btn ${cls}`, onclick: async (e) => { try { await submitting(e.currentTarget, fn); } catch (er) { toastError(er); } } }, label));
  const a = [];
  if (can.manage) a.push(act('Notify attendees', 'Email all ticket holders an update.', 'ghost', async () => { const m = await promptDialog('Message to attendees', { multiline: true, confirmLabel: 'Send' }); if (!m) return; const r = await api.post(`/api/organizer/events/${id}/announce`, { message: m }); toast(`Queued for ${r.notified} attendees`, 'ok'); }));
  if (can.publish) {
    if (ev.status === 'PUBLISHED') a.push(act('Unpublish', 'Hide from the public and stop sales. Existing tickets stay valid.', 'ghost', async () => { if (await confirmDialog('Unpublish this event? Sales will stop.')) { await api.post(`/api/organizer/events/${id}/unpublish`); toast('Unpublished', 'ok'); redo(); } }));
    if (['DRAFT', 'UNPUBLISHED', 'SCHEDULED'].includes(ev.status)) a.push(act('Publish', 'Make this event public.', 'coral', async () => { await api.post(`/api/organizer/events/${id}/publish`); toast('Published', 'ok'); redo(); }));
    a.push(act('Duplicate', 'Create a draft copy of this event.', 'ghost', async () => { const d = await api.post(`/api/organizer/events/${id}/duplicate`); location.hash = `#/events/${d.id}/edit`; }));
    if (!['CANCELLED', 'SUSPENDED'].includes(ev.status)) a.push(act('Cancel event', 'Cancels the event and starts automatic refunds for all paid orders. This cannot be undone.', 'danger', async () => { const r = await promptDialog('Cancel this event', { label: 'Reason (sent to every attendee)', multiline: true, confirmLabel: 'Cancel event and refund' }); if (!r) return; await api.post(`/api/organizer/events/${id}/cancel`, { reason: r }); toast('Event cancelled. Refunds are being processed.', 'ok'); redo(); }));
    if (ev.status === 'SUSPENDED') a.push(act('Appeal suspension', 'Send a message to the platform team.', 'coral', async () => { const m = await promptDialog('Appeal', { label: 'Explain why this suspension should be lifted', multiline: true }); if (!m) return; await api.post(`/api/organizer/events/${id}/appeal`, { message: m }); toast('Appeal sent', 'ok'); }));
  }
  mount(body, h('div', { class: 'stack' }, a.length ? a : empty('No actions available for your role')));
}
