import { boot, api, h, mount, eventCard, skeleton, empty, pager, params, qs } from '/js/core.js';

const main = await boot({ active: 'events' });
const p = params();
const cats = await api.get('/api/categories').catch(() => []);
const q = Object.fromEntries(['q', 'category', 'city', 'from', 'to', 'price', 'sort', 'available'].map((k) => [k, p.get(k) || '']));
q.page = Number(p.get('page')) || 1;
const results = h('div', null, skeleton(3, 200));
const sel = (name, opts, label) => h('div', { class: 'field' }, h('label', { for: name }, label), h('select', { id: name, name }, opts.map(([v, t]) => h('option', { value: v, selected: v === q[name] }, t))));
const inp = (name, label, type = 'text') => h('div', { class: 'field' }, h('label', { for: name }, label), h('input', { class: 'input', id: name, name, type, value: q[name] }));
const form = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); Object.assign(q, Object.fromEntries(new FormData(form).entries()), { available: form.available.checked ? 'true' : '', page: 1 }); load(); } },
  inp('q', 'Search', 'search'), inp('city', 'City'),
  sel('category', [['', 'All categories'], ...cats.map((c) => [c.slug, c.name])], 'Category'),
  sel('price', [['', 'Any price'], ['free', 'Free'], ['paid', 'Paid']], 'Price'),
  inp('from', 'From date', 'date'), inp('to', 'To date', 'date'),
  sel('sort', [['date', 'Soonest'], ['popular', 'Popular'], ['new', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low']], 'Sort'),
  h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'available', checked: q.available === 'true' }), 'Hide sold out'),
  h('button', { class: 'btn coral', type: 'submit' }, 'Apply'));
const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Categories', style: { margin: '0 0 16px' } });
function renderChips() {
  mount(chips, ...[['', 'All'], ...cats.map((c) => [c.slug, c.name])].map(([slug, name]) => h('a', { class: `chip${q.category === slug ? ' on' : ''}`, href: `/events${qs({ category: slug })}`, onclick: (e) => { e.preventDefault(); q.category = slug; q.page = 1; form.category.value = slug; load(); } }, name)));
}
mount(main, h('div', { class: 'wrap section' }, h('h1', { style: { fontSize: 'var(--fs-4)' } }, 'Explore events'), cats.length ? chips : null, form, results));

async function load() {
  renderChips();
  history.replaceState(null, '', `/events${qs({ ...q, page: q.page > 1 ? q.page : '' })}`);
  mount(results, skeleton(3, 200));
  try {
    const r = await api.getFull(`/api/events${qs({ ...q, pageSize: 12 })}`);
    mount(results, r.data.length ? h('div', { class: 'grid g4' }, r.data.map(eventCard)) : empty('No events match', 'Try changing your filters or search.'), pager(r.meta, (n) => { q.page = n; load(); window.scrollTo({ top: 0 }); }));
  } catch (e) { mount(results, empty('Could not load events', e.message)); }
}
load();