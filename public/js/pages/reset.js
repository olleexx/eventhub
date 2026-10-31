import { boot, api, h, mount, formError, submitting, params } from '/js/core.js';

const main = await boot();
const token = params().get('token') || location.hash.slice(1);
const card = h('div', { class: 'card auth-card' });
const form = h('form', { novalidate: true, onsubmit: async (e) => {
  e.preventDefault();
  try { await submitting(form.querySelector('button'), async () => { await api.post('/api/auth/reset-password', { token, password: form.password.value }); mount(card, h('h2', null, 'Password updated'), h('p', null, 'You can now sign in with your new password.'), h('a', { class: 'btn coral', href: '/login' }, 'Sign in')); }); } catch (err) { formError(form, err); }
} }, h('div', { class: 'field' }, h('label', { for: 'password' }, 'New password'), h('input', { class: 'input', id: 'password', name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true }), h('span', { class: 'hint' }, 'At least 10 characters.')), h('button', { class: 'btn coral block', type: 'submit' }, 'Update password'));
mount(card, h('h2', null, 'Choose a new password'), token ? form : h('p', null, 'This reset link is invalid. Request a new one.'));
mount(main, h('div', { class: 'auth-shell' }, card));
