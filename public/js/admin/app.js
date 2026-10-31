import { loadMe, state, h, mount, api, empty, skeleton } from '/js/core.js';
import * as V from './views.js';

await loadMe();
const app = document.getElementById('app');
if (!state.user) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`); throw new Error('redirect'); }
if (state.user.role !== 'ADMIN') { mount(app, h('div', { class: 'wrap section' }, empty('Admins only', 'Your account does not have access to this console.', { href: '/', label: 'Go home' }))); throw new Error('forbidden'); }

const NAV = [['#/', 'Overview', '📊', V.overview], ['#/users', 'Users', '👤', V.users], ['#/organizers', 'Organizers', '🏷️', V.organizers], ['#/events', 'Events', '🎟️', V.events], ['#/orders', 'Orders & payments', '🧾', V.orders], ['#/refunds', 'Refunds', '↩️', V.refunds], ['#/settlements', 'Payouts', '💰', V.settlements], ['#/reconciliation', 'Reconciliation', '🔍', V.reconciliation], ['#/moderation', 'Moderation & support', '🛡️', V.moderation], ['#/reports', 'Commission reports', '📈', V.reports], ['#/audit', 'Audit log', '📜', V.audit], ['#/settings', 'Settings', '⚙️', V.settings], ['#/system', 'System & email', '🖥️', V.system]];
const content = h('div', { class: 'content', id: 'main', tabindex: '-1' });
async function route() {
  const hash = location.hash || '#/';
  mount(app, h('div', { class: 'shell' }, h('nav', { class: 'side', 'aria-label': 'Admin' }, h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }, '●'), 'Admin'),
    NAV.map(([href, label, ic]) => h('a', { href, 'aria-current': (href === '#/' ? hash === '#/' : hash.startsWith(href)) ? 'page' : undefined }, h('span', { 'aria-hidden': 'true' }, ic), label)),
    h('div', { class: 'spacer' }), h('small', null, state.user.email), h('a', { href: '/organizer' }, 'Organizer view'), h('button', { class: 'nav-item', onclick: async () => { await api.post('/api/auth/logout').catch(() => {}); location.href = '/'; } }, 'Sign out')), content));
  const [, , , fn] = NAV.find(([href]) => (href === '#/' ? hash === '#/' || hash === '' : hash.startsWith(href))) || [];
  if (!fn) return mount(content, empty('Page not found'));
  mount(content, skeleton(2, 140));
  try { await fn(content); } catch (e) { mount(content, empty('Something went wrong', e.message)); }
  content.focus({ preventScroll: true });
}
addEventListener('hashchange', route);
route();
