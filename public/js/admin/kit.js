import { api, h, mount, empty, pager, qs, fmtDT, toast, toastError, promptDialog, confirmDialog } from '/js/core.js';

/** Generic searchable, paged table. columns: [{label, render(row), num}] */
export async function pagedTable(root, { title, url, columns, filters = [], search = true, extra, pageSize = 20, emptyText = 'Nothing here yet' }) {
  const q = { q: '', page: 1 }; filters.forEach((f) => { q[f.name] = ''; });
  const list = h('div', null);
  const bar = h('div', { class: 'toolbar' }, search && h('input', { class: 'input', type: 'search', placeholder: 'Search', 'aria-label': 'Search', oninput: (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 300); }; })() }),
    filters.map((f) => h('select', { 'aria-label': f.label, onchange: (e) => { q[f.name] = e.target.value; q.page = 1; load(); } }, [h('option', { value: '' }, f.label), ...f.options.map((o) => h('option', { value: o }, o.replace(/_/g, ' ').toLowerCase()))])), extra);
  mount(root, h('header', null, h('h1', null, title)), bar, list);
  async function load() {
    const r = await api.getFull(`${url}${qs({ ...q, pageSize })}`);
    mount(list, r.data.length ? table(columns, r.data) : empty(emptyText), pager(r.meta, (n) => { q.page = n; load(); }));
  }
  load.reload = load;
  await load();
  return load;
}
export const table = (columns, rows) => h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))), h('tbody', null, rows.map((r) => h('tr', null, columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render(r))))))));
export const btn = (label, fn, cls = 'ghost') => h('button', { class: `btn ${cls} sm`, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (err) { toastError(err); } finally { b.disabled = false; } } }, label);
export const ask = (title, opts) => promptDialog(title, { multiline: true, ...opts });
export { fmtDT, toast, confirmDialog, api, h, mount, empty, qs };
