import { boot, api, h, mount, formObj, formError, submitting } from '/js/core.js';

const main = await boot();
const card = h('div', { class: 'card auth-card' });
const form = h('form', { novalidate: true, onsubmit: async (e) => {
  e.preventDefault();
  try { await submitting(form.querySelector('button'), async () => { await api.post('/api/auth/forgot-password', formObj(form)); mount(card, h('h2', null, 'Check your inbox'), h('p', null, 'If an account exists for that email, we have sent a link to reset your password. It expires soon.')); }); } catch (err) { formError(form, err); }
} }, h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), h('input', { class: 'input', id: 'email', name: 'email', type: 'email', required: true })), h('button', { class: 'btn coral block', type: 'submit' }, 'Send reset link'));
mount(card, h('h2', null, 'Reset your password'), form);
mount(main, h('div', { class: 'auth-shell' }, card));
