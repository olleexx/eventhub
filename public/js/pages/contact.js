import { boot, api, h, mount, state, formObj, formError, submitting, toast } from '/js/core.js';

const main = await boot();
const form = h('form', { novalidate: true, onsubmit: async (e) => {
  e.preventDefault();
  const body = formObj(form); if (body.orderReference) body.message = `[Order ${body.orderReference.slice(0, 40)}] ${body.message}`; delete body.orderReference; if (state.user) delete body.email;
  try { await submitting(form.querySelector('button'), async () => { await api.post('/api/support', body); form.reset(); toast('Message sent. We will reply by email.', 'ok'); }); } catch (err) { formError(form, err); }
} },
  !state.user && h('div', { class: 'field' }, h('label', { for: 'email' }, 'Your email'), h('input', { class: 'input', id: 'email', name: 'email', type: 'email', required: true })),
  h('div', { class: 'field' }, h('label', { for: 'subject' }, 'Subject'), h('input', { class: 'input', id: 'subject', name: 'subject', maxlength: 150, required: true })),
  h('div', { class: 'field' }, h('label', { for: 'orderReference' }, 'Order reference (optional)'), h('input', { class: 'input', id: 'orderReference', name: 'orderReference' })),
  h('div', { class: 'field' }, h('label', { for: 'message' }, 'How can we help?'), h('textarea', { id: 'message', name: 'message', maxlength: 3000, required: true })),
  h('button', { class: 'btn coral', type: 'submit' }, 'Send message'));
mount(main, h('div', { class: 'wrap section', style: { maxWidth: '640px' } }, h('h1', { style: { fontSize: 'var(--fs-4)' } }, 'Contact support'), state.settings.supportEmail && h('p', { class: 'muted' }, `Or email ${state.settings.supportEmail}.`), h('div', { class: 'card' }, form)));
