// Shared client library. Security rule: user-supplied text is only ever inserted with textContent /
// text nodes (h() below), never innerHTML, so event titles/descriptions cannot inject markup.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

export function mount(root, ...nodes) { root.replaceChildren(...nodes.flat().filter(Boolean)); return root; }

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(status, body) { super(body?.error?.message || 'Request failed'); this.status = status; this.code = body?.error?.code; this.details = body?.error?.details; }
}
export const state = { user: null, csrf: null, settings: {}, announcements: [] };

async function request(method, url, body, isForm) {
  const headers = { Accept: 'application/json' };
  if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  let res;
  try { res = await fetch(url, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, { error: { message: 'Network problem. Check your connection and try again.', code: 'NETWORK' } }); }
  let json = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) {
    if (res.status === 403 && json?.error?.code?.startsWith('CSRF')) { await loadMe(); }
    throw new ApiError(res.status, json);
  }
  return json;
}
export const api = {
  get: (u) => request('GET', u).then((j) => j.data),
  getFull: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}).then((j) => j.data),
  put: (u, b) => request('PUT', u, b ?? {}).then((j) => j.data),
  patch: (u, b) => request('PATCH', u, b ?? {}).then((j) => j.data),
  del: (u) => request('DELETE', u).then((j) => j.data),
  upload: (u, file, extra = {}) => { const f = new FormData(); f.append('file', file); Object.entries(extra).forEach(([k, v]) => f.append(k, v)); return request('POST', u, f, true).then((j) => j.data); },
};
export const qs = (obj) => { const p = new URLSearchParams(); Object.entries(obj).forEach(([k, v]) => v !== undefined && v !== null && v !== '' && p.set(k, v)); const s = p.toString(); return s ? `?${s}` : ''; };

export async function loadMe() {
  try {
    const d = await api.get('/api/auth/me');
    state.user = d.user; state.csrf = d.csrfToken; state.settings = d.settings || {}; state.announcements = d.announcements || [];
  } catch { /* offline: render as signed-out */ }
  return state.user;
}

// ------------------------------------------------------------------ formatting
export function money(v, currency = 'NGN') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'Free';
  const sym = currency === 'NGN' ? '₦' : `${currency} `;
  const hasKobo = Math.round(n * 100) % 100 !== 0;
  return sym + n.toLocaleString('en-NG', { minimumFractionDigits: hasKobo ? 2 : 0, maximumFractionDigits: 2 });
}
export const moneyZero = (v, c) => (Number(v) === 0 ? (c === 'NGN' || !c ? '₦0' : `${c} 0`) : money(v, c));
export function fmtDate(iso, tz = 'Africa/Lagos', opts = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) {
  if (!iso) return 'TBA';
  try { return new Intl.DateTimeFormat('en-NG', { ...opts, timeZone: tz }).format(new Date(iso)); } catch { return new Date(iso).toLocaleString(); }
}
export const fmtDay = (iso, tz) => fmtDate(iso, tz, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtShort = (iso) => (iso ? new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
export const num = (n) => Number(n ?? 0).toLocaleString('en-NG');
// datetime-local helpers (Africa/Lagos is UTC+1 with no DST; we render in the event timezone via Intl)
export function toInputDT(iso, tz = 'Africa/Lagos') {
  if (!iso) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function fromInputDT(local, tz = 'Africa/Lagos') {
  if (!local) return undefined;
  // Interpret the wall-clock value in `tz`: find the UTC instant whose tz-rendering equals the input.
  const [d, t] = local.split('T'); const [Y, M, D] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
  let guess = Date.UTC(Y, M - 1, D, hh, mm);
  for (let i = 0; i < 2; i++) {
    const shown = toInputDT(new Date(guess).toISOString(), tz); const [sd, st] = shown.split('T'); const [sY, sM, sD] = sd.split('-').map(Number); const [sh, sm] = st.split(':').map(Number);
    guess += Date.UTC(Y, M - 1, D, hh, mm) - Date.UTC(sY, sM - 1, sD, sh, sm);
  }
  return new Date(guess).toISOString();
}
export const relTime = (iso) => { const s = Math.round((new Date(iso) - Date.now()) / 1000); const a = Math.abs(s); const u = a < 3600 ? [Math.round(a / 60), 'min'] : a < 86400 ? [Math.round(a / 3600), 'h'] : [Math.round(a / 86400), 'd']; return s >= 0 ? `in ${u[0]} ${u[1]}` : `${u[0]} ${u[1]} ago`; };

const PALETTES = [['#4338f0', '#7a5cff'], ['#14122b', '#4338f0'], ['#0b7a62', '#2b9cf0'], ['#7a5cff', '#d4a64a'], ['#d4a64a', '#4338f0'], ['#0c0e1a', '#6d63ff']];
const COVERS = ['music', 'tech', 'food', 'arts', 'sports', 'nightlife'];
const COVER_RULES = [[/night|club|part(y|ies)|rave|lounge/i, 'nightlife'], [/music|concert|gig|\bdj\b|band|jazz|choir|opera/i, 'music'], [/tech|startup|develop|digital|\bai\b|software|business|network|conference|summit/i, 'tech'], [/food|drink|dining|culinary|wine|cook|market|brunch/i, 'food'], [/\barts?\b|culture|gallery|theat|exhibit|design|dance|film|comed/i, 'arts'], [/sport|fitness|run|game|match|football|soccer|yoga|health/i, 'sports']];
/** Banner background: the organizer's image, else brand cover art matched to the category, else a brand gradient. */
export function bannerStyle(title = '', url, category = '') {
  if (url) return { backgroundImage: `url("${url.replace(/["\\]/g, '')}")`, backgroundSize: 'cover', backgroundPosition: 'center' };
  let hash = 0; for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = PALETTES[hash % PALETTES.length];
  const hit = COVER_RULES.find(([re]) => re.test(category || ''));
  const cover = hit ? hit[1] : COVERS[hash % COVERS.length];
  return { backgroundImage: `url("/img/cover-${cover}.jpg"), linear-gradient(135deg, ${a}, ${b})`, backgroundSize: 'cover', backgroundPosition: 'center' };
}

// Static, trusted SVG icons (no user text ever reaches innerHTML).
const ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V7M17 16v-8"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
};
export function icon(name) {
  const el = document.createElement('span'); el.className = 'ico'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return el;
}

// ------------------------------------------------------------------ feedback UI
let toastRoot;
export function toast(msg, type = '') {
  toastRoot ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast ${type}` }, msg);
  toastRoot.appendChild(t);
  setTimeout(() => t.remove(), type === 'bad' ? 6500 : 3800);
}
export const toastError = (err) => toast(err?.message || 'Something went wrong', 'bad');

export function modal({ title, body, actions = [], onClose }) {
  const previous = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); previous?.focus?.(); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h3', null, title), body, h('div', { class: 'actions' }, actions.map((a) => h('button', { class: `btn ${a.class || ''}`, type: 'button', onclick: () => a.onClick?.({ close }) ?? (a.close !== false && close()) }, a.label))));
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && close() }, dlg);
  document.body.appendChild(overlay); document.addEventListener('keydown', onKey);
  dlg.querySelector('input,select,textarea,button')?.focus();
  return { close, el: dlg };
}
export const confirmDialog = (message, { confirmLabel = 'Confirm', danger = false, title = 'Are you sure?' } = {}) => new Promise((resolve) => {
  modal({ title, body: h('p', null, message), onClose: () => resolve(false), actions: [{ label: 'Cancel', class: 'ghost', onClick: ({ close }) => { resolve(false); close(); } }, { label: confirmLabel, class: danger ? 'danger' : 'coral', onClick: ({ close }) => { resolve(true); close(); } }] });
});
export const promptDialog = (title, { label, type = 'text', placeholder = '', confirmLabel = 'Submit', multiline = false } = {}) => new Promise((resolve) => {
  const input = h(multiline ? 'textarea' : 'input', { class: 'input', type, placeholder, 'aria-label': label || title });
  let done = false;
  const finish = (v, close) => { done = true; resolve(v); close(); };
  modal({ title, body: h('div', { class: 'field' }, label && h('label', null, label), input), onClose: () => !done && resolve(null), actions: [{ label: 'Cancel', class: 'ghost', onClick: ({ close }) => finish(null, close) }, { label: confirmLabel, class: 'coral', onClick: ({ close }) => finish(input.value.trim() || null, close) }] });
});

export function setFieldErrors(form, details = []) {
  $$('.field.invalid', form).forEach((f) => { f.classList.remove('invalid'); $('.err', f)?.remove(); });
  let first;
  for (const d of details) {
    const input = form.querySelector(`[name="${d.path}"]`) || form.querySelector(`[name="${d.path.split('.')[0]}"]`);
    const field = input?.closest('.field');
    if (!field) continue;
    field.classList.add('invalid'); field.appendChild(h('div', { class: 'err', role: 'alert' }, d.message)); first ??= input;
  }
  first?.focus();
  return Boolean(first);
}
export function formError(form, err) {
  $('.form-error', form)?.remove();
  if (err?.details && setFieldErrors(form, err.details)) return;
  form.prepend(h('div', { class: 'form-error', role: 'alert' }, err?.message || 'Something went wrong'));
}
export async function submitting(btn, fn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Please wait…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}
export const formObj = (form) => Object.fromEntries(new FormData(form).entries());

export const skeleton = (n = 3, height = 90) => h('div', { class: 'stack', 'aria-busy': 'true' }, Array.from({ length: n }, () => h('div', { class: 'skeleton', style: { height: `${height}px` } })));
export const empty = (title, text, cta) => h('div', { class: 'empty' }, h('h4', null, title), text && h('p', null, text), cta && h('a', { class: 'btn coral', href: cta.href, onclick: cta.onClick }, cta.label));
export function pager(meta, onPage) {
  if (!meta || meta.totalPages <= 1) return null;
  return h('nav', { class: 'pager', 'aria-label': 'Pagination' }, h('button', { class: 'btn ghost sm', disabled: meta.page <= 1, onclick: () => onPage(meta.page - 1) }, '← Prev'), h('span', { class: 'small muted' }, `Page ${meta.page} of ${meta.totalPages} · ${num(meta.total)} total`), h('button', { class: 'btn ghost sm', disabled: meta.page >= meta.totalPages, onclick: () => onPage(meta.page + 1) }, 'Next →'));
}
export const statusBadge = (s) => {
  const map = { PAID: 'ok', PUBLISHED: 'ok', VALID: 'ok', COMPLETED: 'ok', ACTIVE: 'ok', SENT: 'ok', PROCESSED: 'ok', ADMITTED: 'ok', PENDING: 'warn', REQUESTED: 'warn', APPROVED: 'info', PROCESSING: 'info', SCHEDULED: 'info', DRAFT: '', USED: 'info', PARTIALLY_REFUNDED: 'warn', REFUNDED: 'warn', NEEDS_REVIEW: 'bad', FAILED: 'bad', CANCELLED: 'bad', SUSPENDED: 'bad', REJECTED: 'bad', EXPIRED: '', UNPUBLISHED: 'warn', OPEN: 'warn' };
  return h('span', { class: `badge ${map[s] ?? ''}` }, String(s).replace(/_/g, ' ').toLowerCase());
};
export function download(url) { const a = h('a', { href: url, download: '' }); document.body.appendChild(a); a.click(); a.remove(); }

// ------------------------------------------------------------------ chrome (header / footer)
export function renderHeader({ active } = {}) {
  const s = state.settings; const u = state.user;
  const name = s.platformName || 'EventHub';
  const dash = u?.role === 'ADMIN' ? [h('a', { href: '/admin' }, 'Admin dashboard')] : [];
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    h('a', { href: '/events', class: active === 'events' ? 'on' : '' }, 'Explore'),
    h('a', { href: u?.isOrganizer ? '/organizer#/events/new' : '/register?organizer=1', class: 'nav-cta' }, 'Create event'),
    u ? h('details', { class: 'menu' }, h('summary', { 'aria-label': 'Account menu' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, (u.name || '?')[0].toUpperCase()), h('span', { class: 'menu-name' }, u.name.split(' ')[0])),
      h('div', { class: 'menu-pop' },
        h('a', { href: '/account' }, 'My tickets'), h('a', { href: '/account#orders' }, 'Orders'), h('a', { href: '/account#saved' }, 'Saved events'),
        u.isOrganizer ? h('a', { href: '/organizer' }, 'Organizer dashboard') : h('a', { href: '/register?organizer=1' }, 'Become an organizer'),
        u.isOrganizer && h('a', { href: '/scan' }, 'Scan tickets'), dash, h('a', { href: '/account#settings' }, 'Settings'),
        h('button', { class: 'link-btn', onclick: async () => { await api.post('/api/auth/logout').catch(() => {}); location.href = '/'; } }, 'Sign out')))
      : [h('a', { href: '/login' }, 'Sign in'), h('a', { class: 'btn coral sm', href: '/register' }, 'Sign up')]);
  const bars = [];
  if (s.maintenanceMode) bars.push(h('div', { class: 'banner' }, 'Ticket sales are paused for maintenance. Browsing still works.'));
  for (const a of state.announcements) bars.push(h('div', { class: 'banner info', title: a.body }, h('strong', null, a.title), ' — ', a.body));
  if (u && !u.emailVerified) bars.push(h('div', { class: 'banner' }, 'Please verify your email. ', h('button', { class: 'link', style: { color: '#14122b' }, onclick: async (e) => { try { await api.post('/api/auth/resend-verification'); e.target.textContent = 'Sent! Check your inbox.'; } catch (er) { toastError(er); } } }, 'Resend verification email')));
  return h('div', null, h('a', { class: 'skip', href: '#main' }, 'Skip to content'), ...bars,
    h('header', { class: 'site-header' }, h('div', { class: 'wrap row between' }, h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '●'), name), nav)));
}
export function renderFooter() {
  const s = state.settings;
  return h('footer', { class: 'site-footer' }, h('div', { class: 'wrap grid g4' },
    h('div', null, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '●'), s.platformName || 'EventHub'), h('p', { class: 'muted small' }, 'Create events for free. Sell tickets with confidence. We only earn when you do.')),
    h('div', null, h('h4', null, 'Discover'), h('a', { href: '/events' }, 'All events'), h('br'), h('a', { href: '/events?price=free' }, 'Free events'), h('br'), h('a', { href: '/login' }, 'My tickets')),
    h('div', null, h('h4', null, 'Organizers'), h('a', { href: '/register?organizer=1' }, 'Create an event'), h('br'), h('a', { href: '/organizer' }, 'Organizer dashboard'), h('br'), h('a', { href: '/scan' }, 'Ticket scanner')),
    h('div', null, h('h4', null, 'Help'), h('a', { href: '/contact' }, 'Contact support'), h('br'), h('a', { href: '/terms' }, 'Terms of service'), h('br'), h('a', { href: '/privacy' }, 'Privacy policy'), h('br'), h('a', { href: '/refund-policy' }, 'Refund policy'), s.supportEmail && h('p', { class: 'small muted' }, s.supportEmail))),
    h('div', { class: 'wrap small muted center', style: { padding: '24px 0' } }, `© ${new Date().getFullYear()} ${s.platformName || 'EventHub'}`));
}

export function eventCard(e) {
  const tag = e.soldOut ? h('span', { class: 'badge bad' }, 'Sold out') : e.lowStock ? h('span', { class: 'badge warn' }, `Only ${e.ticketsRemaining} left`) : e.isFree ? h('span', { class: 'badge ok' }, 'Free') : null;
  return h('a', { class: e.soldOut ? 'ecard off' : 'ecard', href: `/e/${encodeURIComponent(e.slug)}`, 'data-start': e.startsAt, 'data-end': e.endsAt },
    h('div', { class: 'ecard-img', style: bannerStyle(e.title, e.bannerUrl, e.category?.name), role: 'img', 'aria-label': `${e.title} banner` }, tag && h('div', { class: 'ecard-tag' }, tag), e.category && h('span', { class: 'ecard-cat' }, e.category.name)),
    h('div', { class: 'ecard-body' }, h('div', { class: 'ecard-date' }, fmtDate(e.startsAt, e.timezone)), h('h3', null, e.title), h('div', { class: 'muted small' }, [e.venueName, e.city].filter(Boolean).join(' · ') || 'Online'),
      h('div', { class: 'row between ecard-foot' }, h('strong', null, e.minPrice == null ? 'Tickets soon' : e.isFree ? 'Free' : `From ${money(e.minPrice, e.currency)}`), h('span', { class: 'small muted' }, e.organizer?.brandName || ''))));
}

export async function boot({ active, mainSelector = '#main' } = {}) {
  await loadMe();
  const top = $('#chrome-top'); const bottom = $('#chrome-bottom');
  if (top) top.replaceWith(renderHeader({ active }));
  if (bottom) bottom.replaceWith(renderFooter());
  return $(mainSelector);
}
export const params = () => new URLSearchParams(location.search);
export function requireLogin() { if (!state.user) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`; return false; } return true; }
export const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');