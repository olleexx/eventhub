import { boot, api, h, mount, params } from '/js/core.js';

const main = await boot();
const card = h('div', { class: 'card auth-card center' }, h('div', { class: 'spinner' }));
mount(main, h('div', { class: 'auth-shell' }, card));
const token = params().get('token') || location.hash.slice(1);
try {
  if (!token) throw new Error('This verification link is incomplete.');
  await api.post('/api/auth/verify-email', { token });
  mount(card, h('h2', null, 'Email verified'), h('p', null, 'Thanks, your email address is confirmed.'), h('a', { class: 'btn coral', href: '/account' }, 'Continue'));
} catch (e) { mount(card, h('h2', null, 'Link not valid'), h('p', null, e.message || 'The link is invalid or has expired.'), h('a', { class: 'btn', href: '/account' }, 'Go to my account')); }
