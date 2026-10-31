import { boot, api, h, icon, mount, state, money, fmtDate, fmtDay, bannerStyle, toast, toastError, formError, submitting, promptDialog, modal, skeleton, empty, ApiError } from '/js/core.js';

const main = await boot({ active: 'events' });
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
mount(main, h('div', { class: 'wrap section' }, skeleton(2, 260)));

let ev;
try { ev = await api.get(`/api/events/${encodeURIComponent(slug)}`); } catch (e) {
  mount(main, h('div', { class: 'wrap section' }, empty('Event not found', 'It may have been removed or is not public.', { href: '/events', label: 'Browse events' })));
  throw e;
}
const cur = ev.currency;
const qty = new Map(); // ticketTypeId -> quantity
let discount = null;   // { code, valid, discount, total }
const totalsBox = h('div', { 'aria-live': 'polite' });
const buyerForm = h('form', { novalidate: true, class: 'hidden', onsubmit: (e) => { e.preventDefault(); checkout(); } });
const buyBox = h('div', { class: 'card buy' });

const selected = () => ev.ticketTypes.filter((t) => qty.get(t.id) > 0).map((t) => ({ t, q: qty.get(t.id) }));
const ticketCount = () => selected().reduce((s, x) => s + x.q, 0);
const subtotal = () => selected().reduce((s, x) => s + Number(x.t.price) * x.q, 0);

function stepper(t) {
  const q = qty.get(t.id) || 0;
  const max = Math.min(t.maxPerOrder, t.remaining);
  const set = (n) => { n = Math.max(0, Math.min(max, n)); if (n > 0 && n < t.minPerOrder) n = n > q ? t.minPerOrder : 0; qty.set(t.id, n); discount = null; renderBuy(); };
  return h('div', { class: 'qty', role: 'group', 'aria-label': `Quantity for ${t.name}` },
    h('button', { type: 'button', 'aria-label': `Remove one ${t.name}`, disabled: q === 0, onclick: () => set(q - 1) }, '−'),
    h('output', { 'aria-live': 'polite' }, String(q)),
    h('button', { type: 'button', 'aria-label': `Add one ${t.name}`, disabled: q >= max, onclick: () => set(q + 1) }, '+'));
}

function stateLabel(t) {
  switch (t.state) {
    case 'SOLD_OUT': return h('span', { class: 'badge bad' }, 'Sold out');
    case 'NOT_STARTED': return h('span', { class: 'badge warn' }, `Sales start ${fmtDate(t.salesStartAt, ev.timezone)}`);
    case 'ENDED': return h('span', { class: 'badge' }, 'Sales ended');
    case 'UNAVAILABLE': return h('span', { class: 'badge' }, 'Unavailable');
    default: return t.remaining <= 10 ? h('span', { class: 'badge warn' }, `${t.remaining} left`) : null;
  }
}

function renderBuy() {
  const canBuy = ev.status === 'PUBLISHED' && !ev.ended && !ev.preview && !state.settings.maintenanceMode;
  const sold = ev.ticketTypes.length > 0 && ev.ticketTypes.every((t) => t.state === 'SOLD_OUT');
  const types = ev.ticketTypes.map((t) => h('div', { class: `tt ${t.state !== 'ON_SALE' ? 'off' : ''}` },
    h('div', { class: 'tt-top' }, h('div', null, h('strong', null, t.name), t.description && h('div', { class: 'small muted' }, t.description), h('div', { style: { marginTop: '6px' } }, stateLabel(t))), h('div', { class: 'tt-price' }, money(t.price, cur))),
    t.state === 'ON_SALE' && canBuy && h('div', { class: 'row between', style: { marginTop: '10px' } }, h('span', { class: 'small muted' }, t.minPerOrder > 1 ? `Min ${t.minPerOrder}` : `Max ${t.maxPerOrder}`), stepper(t))));

  const n = ticketCount(); const sub = subtotal();
  const lines = [];
  if (n) {
    selected().forEach(({ t, q }) => lines.push(h('div', { class: 'total-line' }, h('span', null, `${q} × ${t.name}`), h('span', null, money(Number(t.price) * q, cur)))));
    if (discount?.valid) lines.push(h('div', { class: 'total-line' }, h('span', null, `Discount (${discount.code})`), h('span', null, `−${money(discount.discount, cur)}`)));
    const tot = discount?.valid ? Number(discount.total) : sub;
    lines.push(h('div', { class: 'total-line big' }, h('span', null, 'Total'), h('span', null, tot === 0 ? 'Free' : money(tot, cur))));
  }
  mount(totalsBox, ...lines);
  buyerForm.classList.toggle('hidden', !n);

  const extras = [];
  if (!canBuy) extras.push(h('p', { class: 'muted' }, ev.status === 'CANCELLED' ? 'This event has been cancelled.' : ev.ended ? 'This event has ended.' : ev.preview ? 'Preview only: this event is not published yet.' : 'Ticket sales are paused.'));
  if (canBuy && sold && ev.waitlistEnabled) extras.push(h('button', { class: 'btn ghost block', type: 'button', onclick: joinWaitlist }, 'Join the waitlist'));
  mount(buyBox, h('h3', null, 'Tickets'), ev.ticketTypes.length ? types : h('p', { class: 'muted' }, 'Tickets are not on sale yet.'), ...extras, totalsBox, canBuy ? buyerForm : null);
}

function buildBuyerForm() {
  const u = state.user;
  const qs = Array.isArray(ev.customQuestions) ? ev.customQuestions : [];
  const field = (name, label, attrs = {}) => h('div', { class: 'field' }, h('label', { for: `b-${name}` }, label), h('input', { class: 'input', id: `b-${name}`, name, ...attrs }));
  const code = h('input', { class: 'input', id: 'b-code', name: 'discountCode', placeholder: 'Discount code', 'aria-label': 'Discount code', maxlength: 20, style: { textTransform: 'uppercase' } });
  const codeMsg = h('div', { class: 'small', role: 'status' });
  const apply = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
    const c = code.value.trim().toUpperCase(); if (!c) return;
    try {
      const r = await api.post('/api/discounts/preview', { eventId: ev.id, code: c, items: selected().map(({ t, q }) => ({ ticketTypeId: t.id, quantity: q })) });
      discount = r.valid ? { ...r, code: c } : null;
      codeMsg.textContent = r.valid ? 'Code applied.' : 'That code is not valid for this order.'; codeMsg.className = `small ${r.valid ? '' : 'err'}`;
      renderTotalsOnly();
    } catch (e) { toastError(e); }
  } }, 'Apply');
  const questions = qs.map((q) => q.type === 'select'
    ? h('div', { class: 'field' }, h('label', { for: `q-${q.id}` }, q.label + (q.required ? ' *' : '')), h('select', { id: `q-${q.id}`, name: `answers.${q.id}` }, [h('option', { value: '' }, 'Choose…'), ...(q.options || []).map((o) => h('option', { value: o }, o))]))
    : q.type === 'checkbox'
      ? h('label', { class: 'check field' }, h('input', { type: 'checkbox', name: `answers.${q.id}` }), q.label + (q.required ? ' *' : ''))
      : field(`answers.${q.id}`, q.label + (q.required ? ' *' : ''), { maxlength: 300 }));
  mount(buyerForm, h('h4', { style: { marginTop: '16px' } }, 'Your details'),
    field('name', 'Full name', { autocomplete: 'name', required: true, value: u?.name || '' }),
    field('email', 'Email (tickets are sent here)', { type: 'email', autocomplete: 'email', required: true, value: u?.email || '' }),
    field('phone', 'Phone (optional)', { type: 'tel', autocomplete: 'tel', value: u?.phone || '' }),
    ...questions,
    state.settings.featureDiscountCodes && ev.discountsEnabled !== false && h('div', { class: 'field' }, h('label', { for: 'b-code' }, 'Discount code'), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, code, apply), codeMsg),
    h('button', { class: 'btn coral block lg', type: 'submit', id: 'pay-btn' }, 'Continue'),
    h('p', { class: 'small muted center', style: { marginTop: '8px' } }, 'Tickets are held for you while you pay.'));
}
function renderTotalsOnly() { renderBuy(); const keep = buyerForm; /* buyer form instance is preserved */ }

async function checkout() {
  const btn = buyerForm.querySelector('#pay-btn');
  const f = new FormData(buyerForm);
  const answers = {};
  for (const [k, v] of f.entries()) if (k.startsWith('answers.') && v !== '') answers[k.slice(8)] = v;
  (ev.customQuestions || []).filter((q) => q.type === 'checkbox').forEach((q) => { answers[q.id] = f.get(`answers.${q.id}`) === 'on'; });
  const body = {
    eventId: ev.id, items: selected().map(({ t, q }) => ({ ticketTypeId: t.id, quantity: q })),
    buyer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
    discountCode: discount?.valid ? discount.code : undefined, answers: Object.keys(answers).length ? answers : undefined,
    referralSource: new URLSearchParams(location.search).get('ref') || undefined,
  };
  try {
    await submitting(btn, async () => {
      const r = await api.post('/api/checkout', body);
      const tokenQ = r.accessToken ? `?token=${encodeURIComponent(r.accessToken)}` : '';
      if (r.free || !r.checkoutUrl) { location.href = `/orders/${r.reference}${tokenQ}`; return; }
      try { sessionStorage.setItem(`eh.tok.${r.reference}`, r.accessToken || ''); } catch { /* optional */ }
      location.href = r.checkoutUrl;
    });
  } catch (err) {
    if (err instanceof ApiError && ['SOLD_OUT', 'INSUFFICIENT_INVENTORY'].includes(err.code)) { toast(err.message, 'bad'); try { ev = await api.get(`/api/events/${encodeURIComponent(slug)}`); qty.clear(); renderBuy(); } catch { /* ignore */ } return; }
    formError(buyerForm, err);
  }
}

async function joinWaitlist() {
  const email = await promptDialog('Join the waitlist', { label: 'We will email you if tickets become available.', type: 'email', placeholder: 'you@example.com', confirmLabel: 'Join' });
  if (!email) return;
  try { await api.post(`/api/events/${ev.id}/waitlist`, { email }); toast('You are on the waitlist.', 'ok'); } catch (e) { toastError(e); }
}

async function toggleFav(btn) {
  if (!state.user) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return; }
  try { const r = await (ev.favorited ? api.del : api.put)(`/api/events/${ev.id}/favorite`); ev.favorited = r.favorited ?? !ev.favorited; btn.textContent = ev.favorited ? '♥ Saved' : '♡ Save'; btn.setAttribute('aria-pressed', String(ev.favorited)); } catch (e) { toastError(e); }
}

function report() {
  const reason = h('select', { name: 'reason' }, ['scam', 'inappropriate', 'misleading', 'duplicate', 'other'].map((r) => h('option', { value: r }, r[0].toUpperCase() + r.slice(1))));
  const details = h('textarea', { maxlength: 1000, 'aria-label': 'Details' });
  modal({ title: 'Report this event', body: h('div', null, h('div', { class: 'field' }, h('label', null, 'Reason'), reason), h('div', { class: 'field' }, h('label', null, 'Details (optional)'), details)), actions: [
    { label: 'Cancel', class: 'ghost' },
    { label: 'Send report', class: 'coral', onClick: async ({ close }) => { try { await api.post(`/api/events/${ev.id}/report`, { reason: reason.value, details: details.value || undefined }); toast('Thanks, we will review this event.', 'ok'); close(); } catch (e) { toastError(e); } } }] });
}

// ------------------------------------------------------------ page
const where = [ev.venueName, ev.address, ev.city].filter(Boolean).join(', ');
const favBtn = h('button', { class: 'btn ghost sm', type: 'button', 'aria-pressed': String(ev.favorited), onclick: (e) => toggleFav(e.currentTarget) }, ev.favorited ? '♥ Saved' : '♡ Save');
const shareBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { const url = location.origin + location.pathname; try { if (navigator.share) await navigator.share({ title: ev.title, url }); else { await navigator.clipboard.writeText(url); toast('Link copied', 'ok'); } } catch { /* cancelled */ } } }, 'Share');
const heroStyle = bannerStyle(ev.title, ev.bannerUrl, ev.category?.name);
mount(main,
  ev.preview && h('div', { class: 'banner info' }, 'Preview: only you and your team can see this page.'),
  h('section', { class: 'ev-hero', style: heroStyle, 'data-start': ev.startsAt, 'data-end': ev.endsAt }, h('div', { class: 'wrap' },
    ev.status === 'CANCELLED' && h('span', { class: 'badge bad' }, 'Cancelled'),
    ev.category && h('div', { class: 'small', style: { fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' } }, ev.category.name),
    h('h1', null, ev.title),
    h('div', { class: 'meta' }, h('span', { class: 'meta-i' }, icon('calendar'), `${fmtDate(ev.startsAt, ev.timezone)}${ev.endsAt ? ' – ' + fmtDate(ev.endsAt, ev.timezone, { hour: 'numeric', minute: '2-digit' }) : ''}`), where && h('span', { class: 'meta-i' }, icon('pin'), where), ev.onlineUrl && !where && h('span', { class: 'meta-i' }, icon('globe'), 'Online event')))),
  h('div', { class: 'wrap ev-layout' },
    h('div', { class: 'stack' },
      h('div', { class: 'row' }, favBtn, shareBtn, h('button', { class: 'btn ghost sm', type: 'button', onclick: report }, 'Report')),
      ev.shortDescription && h('p', { style: { fontSize: 'var(--fs-3)', fontWeight: 700 } }, ev.shortDescription),
      ev.description && h('section', null, h('h3', null, 'About this event'), h('div', { class: 'prose' }, ev.description)),
      ev.images?.length ? h('section', null, h('h3', null, 'Gallery'), h('div', { class: 'gallery' }, ev.images.map((i) => h('img', { src: i.url, alt: i.alt || '', loading: 'lazy' })))) : null,
      h('section', null, h('h3', null, 'When and where'), h('dl', { class: 'kv' }, h('dt', null, 'Date'), h('dd', null, fmtDay(ev.startsAt, ev.timezone)), h('dt', null, 'Time'), h('dd', null, fmtDate(ev.startsAt, ev.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })), where && [h('dt', null, 'Venue'), h('dd', null, where)], ev.ageRestriction && [h('dt', null, 'Age'), h('dd', null, ev.ageRestriction)]),
        ev.mapUrl && h('p', null, h('a', { href: ev.mapUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open in maps ↗')), ev.venueInstructions && h('p', { class: 'prose muted' }, ev.venueInstructions)),
      h('section', null, h('h3', null, 'Organizer'), h('div', { class: 'org-line' }, h('div', { class: 'org-logo', style: ev.organizer.logoUrl ? { backgroundImage: `url("${ev.organizer.logoUrl.replace(/["\\]/g, '')}")` } : {} }, ev.organizer.logoUrl ? '' : (ev.organizer.brandName || '?')[0]), h('div', null, h('strong', null, ev.organizer.brandName), ev.organizer.bio && h('div', { class: 'small muted prose' }, ev.organizer.bio), ev.organizer.website && h('a', { class: 'small', href: ev.organizer.website, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'Website ↗')))),
      h('section', null, h('h3', null, 'Refunds'), h('p', { class: 'prose' }, ev.refundPolicy || 'Refunds follow the platform refund policy.'), ev.refundDeadline && h('p', { class: 'small muted' }, `Refund requests accepted until ${fmtDate(ev.refundDeadline, ev.timezone)}.`)),
      ev.terms && h('details', null, h('summary', null, 'Event terms'), h('p', { class: 'prose small' }, ev.terms))),
    h('aside', null, buyBox)));
buildBuyerForm();
renderBuy();