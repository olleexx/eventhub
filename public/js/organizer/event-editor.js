import { api, h, mount, money, num, toast, toastError, formError, submitting, confirmDialog, modal, toInputDT, fromInputDT, fmtDT, statusBadge, empty, skeleton } from '/js/core.js';

const STEPS = [['basics', '1. Basics'], ['when', '2. Date & venue'], ['tickets', '3. Tickets'], ['media', '4. Media'], ['policies', '5. Policies'], ['publish', '6. Review & publish']];

export async function eventEditor(root, eventId, step = 'basics') {
  if (!STEPS.some(([k]) => k === step)) step = 'basics';
  const [cats, data] = await Promise.all([api.get('/api/organizer/categories'), eventId ? api.get(`/api/organizer/events/${eventId}`) : null]);
  const ev = data?.event ?? {};
  const tz = ev.timezone || 'Africa/Lagos';
  const idx = STEPS.findIndex(([k]) => k === step);
  const panel = h('div', { class: 'card' });
  const locked = ev.status === 'CANCELLED' || ev.status === 'SUSPENDED';

  mount(root,
    h('header', null, h('h1', null, eventId ? ev.title : 'Create event'), eventId && h('div', { class: 'row' }, statusBadge(ev.status), h('a', { class: 'btn ghost sm', href: `#/events/${eventId}` }, 'Manage'), h('a', { class: 'btn ghost sm', href: `/e/${ev.slug}`, target: '_blank', rel: 'noopener' }, 'Preview page ↗'))),
    h('div', { class: 'stepper', role: 'list' }, STEPS.map(([k, label], i) => h(eventId ? 'a' : 'span', { role: 'listitem', class: `st ${k === step ? 'on' : eventId && i < idx ? 'done' : ''}`, href: eventId ? `#/events/${eventId}/edit/${k}` : undefined, style: { textDecoration: 'none' } }, label))),
    locked && h('div', { class: 'form-error' }, `This event is ${ev.status.toLowerCase()} and can no longer be edited.`), panel);

  const go = (k) => { location.hash = `#/events/${eventId}/edit/${k}`; };
  const nav = (form, next, label = 'Save and continue') => h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'space-between' } }, idx > 0 ? h('a', { class: 'btn ghost', href: `#/events/${eventId}/edit/${STEPS[idx - 1][0]}` }, '← Back') : h('span'), h('button', { class: 'btn coral', type: 'submit', disabled: locked }, label));
  const field = (name, label, attrs = {}, hint) => h('div', { class: 'field' }, h('label', { for: `f-${name}` }, label), attrs.tag === 'textarea' ? h('textarea', { id: `f-${name}`, name, ...attrs.a }, attrs.value || '') : h('input', { class: 'input', id: `f-${name}`, name, ...attrs }), hint && h('span', { class: 'hint' }, hint));
  const save = async (form, patch, next) => {
    try {
      await submitting(form.querySelector('button[type=submit]'), async () => { await api.patch(`/api/organizer/events/${eventId}`, patch); toast('Saved', 'ok'); if (next) go(next); });
    } catch (err) { formError(form, err); }
  };

  if (step === 'basics') {
    const f = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const patch = { title: f.title.value.trim(), categoryId: f.categoryId.value || null, shortDescription: f.shortDescription.value, description: f.description.value };
      if (!eventId) {
        try { await submitting(f.querySelector('button[type=submit]'), async () => { const created = await api.post('/api/organizer/events', patch); location.hash = `#/events/${created.id}/edit/when`; }); } catch (err) { formError(f, err); }
      } else save(f, patch, 'when');
    } },
      field('title', 'Event title', { required: true, maxlength: 120, value: ev.title && ev.title !== 'Untitled event' ? ev.title : '' }),
      h('div', { class: 'field' }, h('label', { for: 'f-cat' }, 'Category'), h('select', { id: 'f-cat', name: 'categoryId' }, [h('option', { value: '' }, 'Choose…'), ...cats.map((c) => h('option', { value: c.id, selected: c.id === ev.categoryId }, c.name))])),
      field('shortDescription', 'Short description', { maxlength: 240, value: ev.shortDescription || '' }, 'One or two sentences shown in search results (10+ characters).'),
      field('description', 'Full description', { tag: 'textarea', a: { maxlength: 10000, rows: 8 }, value: ev.description || '' }, 'Plain text. Line breaks are kept.'),
      nav(null, 'when', eventId ? 'Save and continue' : 'Create draft and continue'));
    mount(panel, h('h3', null, 'Tell people about your event'), f);
  }

  if (step === 'when') {
    const f = h('form', { novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const online = f.onlineUrl.value.trim();
      save(f, { startsAt: fromInputDT(f.startsAt.value, f.timezone.value), endsAt: fromInputDT(f.endsAt.value, f.timezone.value), timezone: f.timezone.value, venueName: f.venueName.value, city: f.city.value, address: f.address.value, onlineUrl: online || null, mapUrl: f.mapUrl.value.trim() || null, venueInstructions: f.venueInstructions.value, refundDeadline: f.refundDeadline.value ? fromInputDT(f.refundDeadline.value, f.timezone.value) : undefined }, 'tickets');
    } },
      h('div', { class: 'grid g2' }, field('startsAt', 'Starts', { type: 'datetime-local', required: true, value: toInputDT(ev.startsAt, tz) }), field('endsAt', 'Ends', { type: 'datetime-local', required: true, value: toInputDT(ev.endsAt, tz) })),
      h('div', { class: 'field' }, h('label', { for: 'f-timezone' }, 'Time zone'), h('select', { id: 'f-timezone', name: 'timezone' }, ['Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London', 'UTC'].map((z) => h('option', { value: z, selected: z === tz }, z)))),
      h('div', { class: 'grid g2' }, field('venueName', 'Venue name', { maxlength: 160, value: ev.venueName || '' }), field('city', 'City', { maxlength: 80, value: ev.city || '' })),
      field('address', 'Address', { maxlength: 300, value: ev.address || '' }),
      field('mapUrl', 'Map link (optional)', { type: 'url', value: ev.mapUrl || '' }),
      field('onlineUrl', 'Online event URL (optional)', { type: 'url', value: ev.onlineUrl || '' }, 'Shown only in confirmation emails, not on the public page. Leave venue blank for a fully online event.'),
      field('venueInstructions', 'Directions / parking notes', { tag: 'textarea', a: { maxlength: 1000, rows: 3 }, value: ev.venueInstructions || '' }),
      field('refundDeadline', 'Last day to request refunds (optional)', { type: 'datetime-local', value: toInputDT(ev.refundDeadline, tz) }, 'Customers can only request refunds before this time.'),
      nav());
    mount(panel, h('h3', null, 'When and where'), f);
  }

  if (step === 'tickets') await ticketsStep(panel, eventId, ev, data, nav, go, locked);

  if (step === 'media') {
    const gal = h('div', { class: 'gallery' });
    const drawGal = (imgs) => mount(gal, ...imgs.map((i) => h('div', null, h('img', { src: i.url, alt: i.alt || '' }), h('button', { class: 'link', type: 'button', onclick: async () => { try { await api.del(`/api/organizer/events/${eventId}/images/${i.id}`); toast('Removed', 'ok'); eventEditor(root, eventId, 'media'); } catch (e) { toastError(e); } } }, 'Remove'))));
    drawGal(data.images);
    const pick = (accept, onFile) => h('input', { type: 'file', accept, class: 'input', 'aria-label': 'Choose image', onchange: async (e) => { const file = e.target.files[0]; if (!file) return; try { await onFile(file); toast('Uploaded', 'ok'); eventEditor(root, eventId, 'media'); } catch (er) { toastError(er); } } });
    mount(panel, h('h3', null, 'Images'), h('div', { class: 'field' }, h('label', null, 'Banner (JPEG, PNG or WebP, recommended 1600×1000)'), ev.bannerUrl && h('img', { src: ev.bannerUrl, alt: 'Current banner', style: { maxWidth: '420px', borderRadius: '12px', marginBottom: '8px' } }), pick('image/jpeg,image/png,image/webp', (f) => api.upload(`/api/organizer/events/${eventId}/banner`, f))),
      h('div', { class: 'field' }, h('label', null, 'Gallery images'), gal, pick('image/jpeg,image/png,image/webp', (f) => api.upload(`/api/organizer/events/${eventId}/images`, f))),
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '16px' } }, h('a', { class: 'btn ghost', href: `#/events/${eventId}/edit/tickets` }, '← Back'), h('a', { class: 'btn coral', href: `#/events/${eventId}/edit/policies` }, 'Continue')));
  }

  if (step === 'policies') {
    let questions = Array.isArray(ev.customQuestions) ? [...ev.customQuestions] : [];
    const qBox = h('div', { class: 'stack' });
    const drawQ = () => mount(qBox, ...questions.map((q, i) => h('div', { class: 'row card flat', style: { padding: '12px' } }, h('strong', null, q.label), h('span', { class: 'badge' }, q.type), q.required && h('span', { class: 'badge warn' }, 'required'), h('button', { class: 'link', type: 'button', onclick: () => { questions.splice(i, 1); drawQ(); } }, 'Remove'))));
    drawQ();
    const qLabel = h('input', { class: 'input', placeholder: 'Question, e.g. T-shirt size', 'aria-label': 'New question' });
    const qType = h('select', { 'aria-label': 'Question type' }, ['text', 'select', 'checkbox'].map((t) => h('option', { value: t }, t)));
    const qOpts = h('input', { class: 'input', placeholder: 'Options (comma separated, for select)', 'aria-label': 'Options' });
    const qReq = h('input', { type: 'checkbox', 'aria-label': 'Required' });
    const f = h('form', { novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      save(f, { refundPolicy: f.refundPolicy.value, terms: f.terms.value, entryInstructions: f.entryInstructions.value, ageRestriction: f.ageRestriction.value, customQuestions: questions }, 'publish');
    } },
      field('refundPolicy', 'Refund policy (required to publish)', { tag: 'textarea', a: { maxlength: 2000, rows: 4 }, value: ev.refundPolicy || '' }, 'Required to publish. Say clearly what buyers can expect.'),
      field('terms', 'Terms and entry rules (required to publish)', { tag: 'textarea', a: { maxlength: 5000, rows: 4 }, value: ev.terms || '' }),
      field('entryInstructions', 'Entry instructions (printed on tickets)', { tag: 'textarea', a: { maxlength: 2000, rows: 3 }, value: ev.entryInstructions || '' }),
      field('ageRestriction', 'Age restriction (optional)', { maxlength: 60, value: ev.ageRestriction || '' }),
      h('h4', null, 'Registration questions (optional)'), qBox,
      h('div', { class: 'toolbar', style: { marginTop: '8px' } }, qLabel, qType, qOpts, h('label', { class: 'check' }, qReq, 'Required'), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => {
        const label = qLabel.value.trim(); if (!label) return;
        if (questions.length >= 8) return toast('Up to 8 questions', 'bad');
        const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || `q${questions.length + 1}`;
        const opts = qOpts.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (qType.value === 'select' && !opts.length) return toast('Add options for a select question', 'bad');
        questions.push({ id: `${id}_${questions.length + 1}`.slice(0, 30), label, type: qType.value, required: qReq.checked, ...(qType.value === 'select' ? { options: opts.slice(0, 12) } : {}) });
        qLabel.value = ''; qOpts.value = ''; qReq.checked = false; drawQ();
      } }, 'Add question')),
      nav());
    mount(panel, h('h3', null, 'Policies and registration'), f);
  }

  if (step === 'publish') {
    const chk = await api.get(`/api/organizer/events/${eventId}/checklist`);
    const publish = async (btn) => { try { await submitting(btn, async () => { await api.post(`/api/organizer/events/${eventId}/publish`); toast('Your event is live!', 'ok'); location.hash = `#/events/${eventId}`; }); } catch (e) { toastError(e); if (e.details) eventEditor(root, eventId, 'publish'); } };
    mount(panel, h('h3', null, 'Review and publish'), h('ul', { class: 'checklist' }, chk.checks.map((c) => { const fix = { title: 'basics', category: 'basics', short: 'basics', description: 'basics', banner: 'media', dates: 'when', venue: 'when', tickets: 'tickets', refund: 'policies', terms: 'policies' }[c.key]; return h('li', { class: c.ok ? 'ok' : 'no' }, c.label, !c.ok && fix && [' ', h('a', { href: `#/events/${eventId}/edit/${fix}` }, 'Fix this →')], !c.ok && c.key === 'email' && h('div', { class: 'small muted' }, 'Open the verification email we sent you and click its link. If no email arrived, SMTP is probably not configured: an admin can see the failure under Admin > System & email, or turn off "Require verified email to publish" under Admin > Settings.')); })),
      !chk.ok && h('p', { class: 'muted' }, 'Complete the items above to publish. You can come back any time: drafts are saved.'),
      h('div', { class: 'row', style: { marginTop: '16px' } }, h('a', { class: 'btn ghost', href: `/e/${ev.slug}`, target: '_blank', rel: 'noopener' }, 'Preview public page ↗'),
        ev.status === 'PUBLISHED' ? h('span', { class: 'badge ok' }, 'Published') : h('button', { class: 'btn coral', disabled: !chk.ok || locked, onclick: (e) => publish(e.currentTarget) }, 'Publish event')));
  }
}

async function ticketsStep(panel, eventId, ev, data, nav, go, locked) {
  const tz = ev.timezone || 'Africa/Lagos';
  const reload = () => eventEditor(panel.closest('.content'), eventId, 'tickets');
  const formFor = (t) => {
    const f = h('form', { novalidate: true, class: 'card flat', style: { marginBottom: '12px' }, onsubmit: async (e) => {
      e.preventDefault();
      const body = { name: f.name.value, description: f.description.value, price: f.price.value || '0', quantityTotal: Number(f.quantityTotal.value), minPerOrder: Number(f.minPerOrder.value || 1), maxPerOrder: Number(f.maxPerOrder.value || 10), salesStartAt: f.salesStartAt.value ? fromInputDT(f.salesStartAt.value, tz) : null, salesEndAt: f.salesEndAt.value ? fromInputDT(f.salesEndAt.value, tz) : null };
      try { await submitting(f.querySelector('button[type=submit]'), async () => { await (t ? api.patch(`/api/organizer/events/${eventId}/ticket-types/${t.id}`, body) : api.post(`/api/organizer/events/${eventId}/ticket-types`, body)); toast('Saved', 'ok'); reload(); }); } catch (err) { formError(f, err); }
    } },
      h('div', { class: 'grid g3' },
        h('div', { class: 'field' }, h('label', null, 'Name'), h('input', { class: 'input', name: 'name', value: t?.name || '', required: true, placeholder: 'e.g. General admission' })),
        h('div', { class: 'field' }, h('label', null, 'Price (₦, 0 = free)'), h('input', { class: 'input', name: 'price', type: 'number', min: 0, step: '0.01', value: t?.price ?? '' })),
        h('div', { class: 'field' }, h('label', null, 'Quantity'), h('input', { class: 'input', name: 'quantityTotal', type: 'number', min: t ? 0 : 1, value: t?.quantityTotal ?? '' }), t && h('span', { class: 'hint' }, `${t.quantitySold} sold, ${t.quantityReserved} held`))),
      h('div', { class: 'field' }, h('label', null, 'Description'), h('input', { class: 'input', name: 'description', value: t?.description || '', maxlength: 500 })),
      h('div', { class: 'grid g4' },
        h('div', { class: 'field' }, h('label', null, 'Min per order'), h('input', { class: 'input', name: 'minPerOrder', type: 'number', min: 1, value: t?.minPerOrder ?? 1 })),
        h('div', { class: 'field' }, h('label', null, 'Max per order'), h('input', { class: 'input', name: 'maxPerOrder', type: 'number', min: 1, value: t?.maxPerOrder ?? 10 })),
        h('div', { class: 'field' }, h('label', null, 'Sales start'), h('input', { class: 'input', name: 'salesStartAt', type: 'datetime-local', value: toInputDT(t?.salesStartAt, tz) })),
        h('div', { class: 'field' }, h('label', null, 'Sales end'), h('input', { class: 'input', name: 'salesEndAt', type: 'datetime-local', value: toInputDT(t?.salesEndAt, tz) }))),
      h('div', { class: 'row' }, h('button', { class: 'btn coral sm', type: 'submit', disabled: locked }, t ? 'Save ticket' : 'Add ticket type'),
        t && h('button', { class: 'btn danger sm', type: 'button', disabled: locked, onclick: async () => { if (!(await confirmDialog(t.quantitySold > 0 ? 'Tickets have been sold, so this type will be hidden and stop selling (sold tickets stay valid).' : 'Delete this ticket type?', { danger: true, confirmLabel: 'Remove' }))) return; try { await api.del(`/api/organizer/events/${eventId}/ticket-types/${t.id}`); toast('Removed', 'ok'); reload(); } catch (e) { toastError(e); } } }, 'Remove')));
    return f;
  };
  mount(panel, h('h3', null, 'Ticket types'), h('p', { class: 'muted small' }, 'Price and quantity changes are recorded in the audit log. Lowering quantity below tickets sold or held is rejected.'),
    ...data.ticketTypes.map(formFor), h('h4', null, data.ticketTypes.length ? 'Add another ticket type' : 'Add your first ticket type (click "Add ticket type" to save it)'), formFor(null),
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '8px' } }, h('a', { class: 'btn ghost', href: `#/events/${eventId}/edit/when` }, '← Back'), h('a', { class: 'btn coral', href: `#/events/${eventId}/edit/media` }, 'Continue')));
}
