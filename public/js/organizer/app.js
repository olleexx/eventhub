import { loadMe, state, h, icon, mount, api, toast, toastError, formError, submitting, empty, skeleton, $ } from '/js/core.js';
import { dashboard } from './dashboard.js';
import { eventsList } from './events-list.js';
import { eventEditor } from './event-editor.js';
import { eventManage } from './event-manage.js';
import { ordersView, refundsView } from './sales.js';
import { financeView, profileView } from './finance.js';

await loadMe();
const app = document.getElementById('app');
if (!state.user) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`); throw new Error('redirect'); }

const NAV = [['#/', 'Dashboard', 'chart'], ['#/events', 'Events', 'ticket'], ['#/orders', 'Sales & orders', 'receipt'], ['#/refunds', 'Refunds', 'undo'], ['#/finance', 'Earnings & payouts', 'wallet'], ['#/profile', 'Brand profile', 'tag']];
const content = h('div', { class: 'content', id: 'main', tabindex: '-1' });

function shell() {
  const here = location.hash || '#/';
  const cur = (href) => (href === '#/' ? here === '#/' || here === '' : here.startsWith(href));
  mount(app, h('div', { class: 'shell' },
    h('nav', { class: 'side', 'aria-label': 'Organizer' }, h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }, '●'), state.settings.platformName || 'EventHub'),
      NAV.map(([href, label, ic]) => h('a', { href, 'aria-current': cur(href) ? 'page' : undefined }, icon(ic), label)),
      h('a', { href: '/scan' }, icon('camera'), 'Scan tickets'), state.user.role === 'ADMIN' && h('a', { href: '/admin' }, icon('shield'), 'Admin'),
      h('div', { class: 'spacer' }), h('small', null, state.user.email), h('a', { href: '/account' }, 'My account'),
      h('button', { class: 'nav-item', onclick: async () => { await api.post('/api/auth/logout').catch(() => {}); location.href = '/'; } }, 'Sign out')),
    content));
}

function becomeOrganizer() {
  const f = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    try { await submitting(f.querySelector('button'), async () => { await api.post('/api/auth/become-organizer', { brandName: f.brandName.value }); await loadMe(); route(); }); } catch (err) { formError(f, err); }
  } }, h('div', { class: 'field' }, h('label', { for: 'bn' }, 'Organizer / brand name'), h('input', { class: 'input', id: 'bn', name: 'brandName', required: true, maxlength: 100 })), h('button', { class: 'btn coral', type: 'submit' }, 'Create organizer profile'));
  mount(app, h('div', { class: 'auth-shell' }, h('div', { class: 'card auth-card' }, h('h2', null, 'Start organizing'), h('p', { class: 'muted' }, 'Creating events is free. A commission applies only to paid tickets sold.'), f)));
}

const routes = [
  [/^#\/?$/, () => dashboard(content), 'owner'],
  [/^#\/events$/, () => eventsList(content)],
  [/^#\/events\/new$/, () => eventEditor(content, null), 'owner'],
  [/^#\/events\/([^/]+)\/edit(?:\/(\w+))?$/, (m) => eventEditor(content, m[1], m[2])],
  [/^#\/events\/([^/]+)(?:\/(\w+))?$/, (m) => eventManage(content, m[1], m[2])],
  [/^#\/orders$/, () => ordersView(content), 'owner'],
  [/^#\/refunds$/, () => refundsView(content), 'owner'],
  [/^#\/finance$/, () => financeView(content), 'owner'],
  [/^#\/profile$/, () => profileView(content), 'owner'],
];
async function route() {
  if (!state.user.isOrganizer && !(location.hash.startsWith('#/events') && !location.hash.includes('new'))) {
    // Staff (non-owners) may use the event pages; everyone else must create an organizer profile first.
    const staffEvents = await api.get('/api/organizer/events?pageSize=1').catch(() => []);
    if (!staffEvents.length) return becomeOrganizer();
  }
  shell();
  const hash = location.hash || '#/';
  for (const [re, fn, need] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    if (need === 'owner' && !state.user.isOrganizer) { location.hash = '#/events'; return; }
    mount(content, skeleton(2, 140));
    try { await fn(m); } catch (e) { mount(content, empty('Something went wrong', e.message)); }
    content.focus({ preventScroll: true });
    return;
  }
  mount(content, empty('Page not found', null, { href: '#/', label: 'Back to dashboard' }));
}
addEventListener('hashchange', route);
route();