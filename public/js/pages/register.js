import { boot, api, h, mount, state, formError, submitting, params, safeNext } from '/js/core.js';

const main = await boot();
const next = safeNext(params().get('next'));
const wantsOrg = params().get('organizer') === '1';
if (state.user) location.replace(wantsOrg ? '/organizer' : next);
const brandField = h('div', { class: 'field', hidden: !wantsOrg }, h('label', { for: 'brandName' }, 'Organizer / brand name'), h('input', { class: 'input', id: 'brandName', name: 'brandName', maxlength: 100 }), h('span', { class: 'hint' }, 'Shown to attendees on your events.'));
const org = h('input', { type: 'checkbox', id: 'asOrganizer', checked: wantsOrg, onchange: () => { brandField.hidden = !org.checked; } });
const form = h('form', { novalidate: true, onsubmit: async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const body = { name: f.get('name'), email: f.get('email'), password: f.get('password'), phone: f.get('phone') || undefined, asOrganizer: org.checked, brandName: org.checked ? f.get('brandName') || undefined : undefined, marketingConsent: form.marketingConsent.checked, acceptTerms: form.acceptTerms.checked ? true : false };
  try { await submitting(form.querySelector('button[type=submit]'), async () => { await api.post('/api/auth/register', body); location.href = org.checked ? '/organizer' : next; }); } catch (err) { formError(form, err); }
} },
  h('div', { class: 'field' }, h('label', { for: 'name' }, 'Full name'), h('input', { class: 'input', id: 'name', name: 'name', autocomplete: 'name', required: true })),
  h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), h('input', { class: 'input', id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true })),
  h('div', { class: 'field' }, h('label', { for: 'phone' }, 'Phone (optional)'), h('input', { class: 'input', id: 'phone', name: 'phone', type: 'tel', autocomplete: 'tel' })),
  h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), h('input', { class: 'input', id: 'password', name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true }), h('span', { class: 'hint' }, 'At least 10 characters.')),
  h('label', { class: 'check', style: { marginBottom: '12px' } }, org, 'I want to create and sell tickets to events'), brandField,
  h('label', { class: 'check', style: { marginBottom: '12px' } }, h('input', { type: 'checkbox', name: 'acceptTerms' }), h('span', null, 'I agree to the ', h('a', { href: '/terms', target: '_blank' }, 'Terms'), ' and ', h('a', { href: '/privacy', target: '_blank' }, 'Privacy Policy'))),
  h('label', { class: 'check', style: { marginBottom: '16px' } }, h('input', { type: 'checkbox', name: 'marketingConsent' }), 'Send me event recommendations (optional)'),
  h('button', { class: 'btn coral block', type: 'submit' }, 'Create account'));
mount(main, h('div', { class: 'auth-shell' }, h('div', { class: 'card auth-card' }, h('h2', null, 'Create your account'), form, h('p', { class: 'center small muted' }, 'Already registered? ', h('a', { href: '/login' }, 'Sign in')))));
