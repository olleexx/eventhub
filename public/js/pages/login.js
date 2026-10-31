import { boot, api, h, mount, state, formObj, formError, submitting, params, safeNext } from '/js/core.js';

const main = await boot();
const next = safeNext(params().get('next'));
if (state.user) location.replace(next);
const form = h('form', { novalidate: true, onsubmit: async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  try { await submitting(btn, async () => { const d = await api.post('/api/auth/login', formObj(form)); location.href = next; }); } catch (err) { formError(form, err); }
} },
  h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), h('input', { class: 'input', id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true })),
  h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), h('input', { class: 'input', id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
  h('button', { class: 'btn coral block', type: 'submit' }, 'Sign in'),
  h('p', { class: 'center small', style: { marginTop: '16px' } }, h('a', { href: '/forgot' }, 'Forgot your password?')));
mount(main, h('div', { class: 'auth-shell' }, h('div', { class: 'card auth-card' }, h('h2', null, 'Welcome back'), form, h('p', { class: 'center small muted' }, 'New here? ', h('a', { href: `/register${location.search}` }, 'Create an account')))));
