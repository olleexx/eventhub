import { api, h, mount, money, num, fmtDT, statusBadge, empty, pager, qs, bannerStyle, toast, toastError, confirmDialog } from '/js/core.js';

export async function eventsList(root) {
  const q = { status: '', q: '', page: 1 };
  const list = h('div', null);
  const status = h('select', { 'aria-label': 'Status', onchange: (e) => { q.status = e.target.value; q.page = 1; load(); } }, [['', 'All statuses'], ...['DRAFT', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'CANCELLED', 'SUSPENDED'].map((s) => [s, s[0] + s.slice(1).toLowerCase()])].map(([v, t]) => h('option', { value: v }, t)));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search events', 'aria-label': 'Search events', oninput: (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 300); }; })() });
  mount(root, h('header', null, h('h1', null, 'Events'), h('a', { class: 'btn coral', href: '#/events/new' }, '+ Create event')), h('div', { class: 'toolbar' }, search, status), list);
  async function load() {
    const r = await api.getFull(`/api/organizer/events${qs({ ...q, pageSize: 15 })}`);
    mount(list, r.data.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Event', 'Date', 'Status', 'Sold', 'Remaining', 'Your role', ''].map((x, i) => h('th', { class: i === 3 || i === 4 ? 'num' : '' }, x)))),
      h('tbody', null, r.data.map((e) => h('tr', null,
        h('td', null, h('a', { href: `#/events/${e.id}`, style: { fontWeight: 700 } }, e.title), e.city && h('div', { class: 'small muted' }, e.city)),
        h('td', null, fmtDT(e.startsAt)), h('td', null, statusBadge(e.status)), h('td', { class: 'num' }, num(e.ticketsSold)), h('td', { class: 'num' }, num(e.ticketsRemaining)), h('td', null, e.myRole?.toLowerCase()),
        h('td', { class: 'right' }, h('a', { class: 'btn ghost sm', href: `#/events/${e.id}/edit` }, 'Edit'), ' ', e.status === 'PUBLISHED' && h('a', { class: 'btn ghost sm', href: `/e/${e.slug}`, target: '_blank', rel: 'noopener' }, 'View'))))))) : empty('No events found', 'Create your first event. It is free.', { href: '#/events/new', label: 'Create event' }), pager(r.meta, (n) => { q.page = n; load(); }));
  }
  await load();
}
