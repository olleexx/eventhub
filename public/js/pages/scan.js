import { boot, api, h, mount, state, requireLogin, toastError, empty, fmtDT, params, num } from '/js/core.js';

const main = await boot();
if (!requireLogin()) throw new Error('redirect');
const events = await api.get('/api/organizer/scannable-events').catch(() => []);
if (!events.length) { mount(main, h('div', { class: 'wrap section' }, empty('No events to scan', 'You need to own an event, or be invited as scanner or manager. Only published events within a day of ending can be scanned.', { href: '/organizer', label: 'Go to dashboard' }))); throw new Error('none'); }

let eventId = params().get('event');
if (!events.some((e) => e.id === eventId)) eventId = events[0].id;
let scanner = null; let busy = false; let last = { code: '', at: 0 };
const result = h('div', { 'aria-live': 'assertive', role: 'status' });
const stats = h('div', { class: 'grid g3', style: { marginTop: '16px' } });
const recent = h('div', { class: 'stack small muted', style: { marginTop: '12px' } });
const manual = h('input', { class: 'input', placeholder: 'Ticket number e.g. EH-AB12-CD34', 'aria-label': 'Ticket number', autocapitalize: 'characters' });
const sel = h('select', { 'aria-label': 'Event', onchange: (e) => { eventId = e.target.value; history.replaceState(null, '', `/scan?event=${eventId}`); refresh(); } }, events.map((e) => h('option', { value: e.id, selected: e.id === eventId }, `${e.title} · ${fmtDT(e.startsAt)}`)));
const camBtn = h('button', { class: 'btn coral block', type: 'button', onclick: toggleCamera }, 'Start camera');
const reader = h('div', { id: 'reader', class: 'hidden' });

mount(main, h('div', { class: 'wrap section scan' }, h('h1', { style: { fontSize: 'var(--fs-4)' } }, 'Scan tickets'), h('div', { class: 'field' }, h('label', null, 'Event'), sel), reader, h('div', { style: { marginTop: '12px' } }, camBtn), result,
  h('form', { class: 'row', style: { marginTop: '16px', flexWrap: 'nowrap' }, onsubmit: (e) => { e.preventDefault(); const v = manual.value.trim(); if (v) submit(v, 'MANUAL'); manual.value = ''; } }, manual, h('button', { class: 'btn', type: 'submit' }, 'Check in')),
  stats, h('h4', { style: { marginTop: '16px' } }, 'Recent check-ins'), recent));

const tone = { ADMITTED: ['ok', '✔ Admitted'], ALREADY_USED: ['bad', '✖ Already scanned'], INVALID: ['bad', '✖ Invalid ticket'], WRONG_EVENT: ['bad', '✖ Wrong event'], REFUNDED: ['bad', '✖ Refunded'], CANCELLED: ['bad', '✖ Cancelled'], EVENT_CANCELLED: ['bad', '✖ Event cancelled'] };
function show(r) {
  const [cls, title] = tone[r.result] || ['warn', r.result];
  mount(result, h('div', { class: `scan-result ${cls}` }, title, h('small', null, [r.ticket?.holderName, r.ticket?.type, r.ticket?.number].filter(Boolean).join(' · ') || r.message), r.result !== 'ADMITTED' && h('small', null, r.message)));
  if (navigator.vibrate) navigator.vibrate(r.result === 'ADMITTED' ? 60 : [120, 60, 120]);
}
async function submit(code, method = 'QR') {
  if (busy) return; busy = true;
  try {
    const scanId = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 40);
    show(await api.post(`/api/checkin/${eventId}/scan`, { code, method, scanId }));
    refresh();
  } catch (e) { mount(result, h('div', { class: 'scan-result bad' }, e.status === 403 ? 'Not allowed to scan this event' : 'Could not check ticket', h('small', null, e.message))); }
  finally { busy = false; }
}
async function refresh() {
  try {
    const s = await api.get(`/api/checkin/${eventId}/stats`);
    mount(stats, ...[['Admitted', s.admitted], ['Still to arrive', s.remainingValid], ['Total valid', s.total]].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, num(v)))));
    mount(recent, ...s.recent.map((r) => h('div', null, `${fmtDT(r.at)} · ${r.holderName || 'Guest'} · ${r.type} · ${r.number}`)));
  } catch { /* stats are best-effort */ }
}
async function toggleCamera() {
  if (scanner) { await scanner.stop().catch(() => {}); scanner = null; reader.classList.add('hidden'); camBtn.textContent = 'Start camera'; return; }
  if (!window.Html5Qrcode) return toastError(new Error('Scanner library not loaded. Use manual entry.'));
  reader.classList.remove('hidden');
  scanner = new window.Html5Qrcode('reader');
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, (text) => {
      const now = Date.now(); if (text === last.code && now - last.at < 3000) return; last = { code: text, at: now }; submit(text, 'QR');
    }, () => {});
    camBtn.textContent = 'Stop camera';
  } catch (e) { scanner = null; reader.classList.add('hidden'); toastError(new Error('Camera unavailable. Allow camera access, or enter ticket numbers manually.')); }
}
refresh();
addEventListener('pagehide', () => scanner?.stop().catch(() => {}));
