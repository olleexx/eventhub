import { api, h, mount, money, num, fmtDT, statusBadge, empty, qs, state } from '/js/core.js';
import { chart, fillDays } from '/js/charts.js';

export async function dashboard(root) {
  let preset = '30d';
  const body = h('div', null);
  const picker = h('select', { 'aria-label': 'Date range', onchange: (e) => { preset = e.target.value; load(); } }, [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']].map(([v, t]) => h('option', { value: v, selected: v === preset }, t)));
  mount(root, h('header', null, h('h1', null, `Welcome, ${state.user.organizer?.brandName || state.user.name}`), h('div', { class: 'row' }, picker, h('a', { class: 'btn coral', href: '#/events/new' }, '+ Create event'))), body);
  async function load() {
    const d = await api.get(`/api/organizer/overview${qs({ preset })}`);
    const t = d.totals; const c = state.settings.currency || 'NGN';
    const stat = (k, v, n) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), n && h('div', { class: 'n' }, n));
    mount(body,
      h('div', { class: 'grid g4' },
        stat('Gross sales', money(t.gross, c) || '₦0', `${num(t.orders)} paid orders`), stat('Net earnings', money(t.net, c) || '₦0', 'After refunds and commission'),
        stat('Tickets sold', num(t.ticketsIssued), `${num(t.ticketsUsed)} checked in`), stat('Tickets remaining', num(d.ticketsRemaining), 'On live events'),
        stat('Commission', money(t.commission, c) || '₦0', 'Net of reversals'), stat('Refunds', money(t.refunds, c) || '₦0', `${num(t.refundCount)} refunds`),
        stat('Pending payments', money(t.pendingAmount, c) || '₦0', `${num(t.pendingOrders)} awaiting payment`), stat('Available balance', money(d.settlements?.available, c) || '₦0', `Pending hold: ${money(d.settlements?.pending, c) || '₦0'}`)),
      h('div', { class: 'grid g2', style: { marginTop: '16px' } },
        h('div', { class: 'card' }, h('h3', null, 'Revenue'), chart(fillDays(d.series, 'revenue', d.range.from, d.range.to), { label: 'Revenue per day', fmt: (v) => money(v, c) || '₦0' })),
        h('div', { class: 'card' }, h('h3', null, 'Tickets sold'), chart(fillDays(d.series, 'tickets', d.range.from, d.range.to), { kind: 'bar', color: 'var(--violet)', label: 'Tickets per day' }))),
      h('div', { class: 'grid g2', style: { marginTop: '16px' } },
        h('div', { class: 'card' }, h('h3', null, 'Your events'), d.upcoming.length ? h('div', { class: 'stack' }, d.upcoming.map((e) => h('div', { class: 'row between' }, h('a', { href: e.status === 'DRAFT' ? `#/events/${e.id}/edit/publish` : `#/events/${e.id}` }, e.title), h('span', { class: 'small muted' }, statusBadge(e.status), ' ', e.startsAt ? `${fmtDT(e.startsAt)} · ` : '', `${num(e.ticketsSold)} sold`)))) : empty('No events yet', 'Create your first event. It is free.', { href: '#/events/new', label: 'Create event' })),
        h('div', { class: 'card' }, h('h3', null, 'Recent orders'), d.recentOrders.length ? h('div', { class: 'stack' }, d.recentOrders.map((o) => h('div', { class: 'row between' }, h('span', null, `${o.buyerName} · ${o.event.title}`), h('span', null, money(o.total, c) || 'Free', ' ', statusBadge(o.status))))) : h('p', { class: 'muted' }, 'No orders yet.'))),
      h('p', { class: 'small muted', style: { marginTop: '16px' } }, `Net earnings = ${d.definitions.net}. Balances are accounting figures from this app, not bank balances.`));
  }
  await load();
}