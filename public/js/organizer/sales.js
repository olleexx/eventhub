import { api, h, mount, money, fmtDT, statusBadge, empty, pager, qs, toast, toastError, promptDialog, confirmDialog } from '/js/core.js';
import { orderTable } from './event-manage.js';

export async function ordersView(root) {
  const q = { q: '', status: '', eventId: '', page: 1 };
  const list = h('div', null);
  const events = await api.get('/api/organizer/events?pageSize=100');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search order, name, email', 'aria-label': 'Search', oninput: (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 300); }; })() });
  const ev = h('select', { 'aria-label': 'Event', onchange: (e) => { q.eventId = e.target.value; q.page = 1; load(); } }, [h('option', { value: '' }, 'All events'), ...events.map((e) => h('option', { value: e.id }, e.title))]);
  const st = h('select', { 'aria-label': 'Status', onchange: (e) => { q.status = e.target.value; q.page = 1; load(); } }, ['', 'PAID', 'PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED', 'FAILED', 'NEEDS_REVIEW'].map((s) => h('option', { value: s }, s ? s.replace(/_/g, ' ').toLowerCase() : 'All statuses')));
  mount(root, h('header', null, h('h1', null, 'Sales & orders'), h('a', { class: 'btn ghost', href: `/api/organizer/orders.csv${qs({ q: q.q, status: q.status, eventId: q.eventId })}`, onclick: (e) => { e.currentTarget.href = `/api/organizer/orders.csv${qs({ q: q.q, status: q.status, eventId: q.eventId })}`; } }, 'Export CSV')), h('div', { class: 'toolbar' }, search, ev, st), list);
  async function load() { const r = await api.getFull(`/api/organizer/orders${qs({ ...q, pageSize: 25 })}`); mount(list, orderTable(r.data, load), pager(r.meta, (n) => { q.page = n; load(); })); }
  await load();
}

export async function refundsView(root) {
  const body = h('div', null);
  mount(root, h('header', null, h('h1', null, 'Refunds')), body);
  const note = h('p', { class: 'muted small' }, 'Refund requests from customers appear here. Approving starts the refund with the payment provider; it is only marked complete when the provider confirms it. Refunds do not restock tickets automatically.');
  async function load() {
    const rows = await api.get('/api/organizer/refunds');
    const review = (r, decision) => async () => {
      const noteText = decision === 'reject' ? await promptDialog('Reject refund', { label: 'Reason (sent to the buyer)', multiline: true }) : '';
      if (decision === 'reject' && !noteText) return;
      if (decision === 'approve' && !(await confirmDialog(`Approve refunding ${money(r.amount, r.order.currency)} to ${r.order.buyerEmail}?`, { confirmLabel: 'Approve refund' }))) return;
      try { await api.post(`/api/organizer/refunds/${r.id}/review`, { decision, note: noteText || undefined }); toast(decision === 'approve' ? 'Refund approved' : 'Refund rejected', 'ok'); load(); } catch (e) { toastError(e); }
    };
    mount(body, note, rows.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Order', 'Event', 'Amount', 'Reason', 'Status', 'Requested', ''].map((x, i) => h('th', { class: i === 2 ? 'num' : '' }, x)))), h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.order.reference, h('div', { class: 'small muted' }, r.order.buyerEmail)), h('td', null, r.order.event.title), h('td', { class: 'num' }, money(r.amount, r.order.currency)), h('td', null, r.reason), h('td', null, statusBadge(r.status)), h('td', null, fmtDT(r.createdAt)), h('td', null, r.status === 'REQUESTED' && h('div', { class: 'row' }, h('button', { class: 'btn coral sm', onclick: review(r, 'approve') }, 'Approve'), h('button', { class: 'btn ghost sm', onclick: review(r, 'reject') }, 'Reject')))))))) : empty('No refunds', 'Refund requests will appear here.'));
  }
  await load();
}
