import { pagedTable, table, btn, ask, fmtDT, toast, confirmDialog, api, h, mount, empty, qs } from './kit.js';
import { money, num, statusBadge, formError, submitting, modal, toastError, state } from '/js/core.js';
import { chart, fillDays } from '/js/charts.js';

const N = (v) => money(v, 'NGN') || '₦0';

export async function overview(root) {
  const preset = '30d';
  const [d, series] = await Promise.all([api.get(`/api/admin/overview?preset=${preset}`), api.get(`/api/admin/overview/series?preset=${preset}`)]);
  const stat = (k, v, n) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), n && h('div', { class: 'n' }, n));
  const c = d.counts, r = d.recordedRevenue, l = d.liabilities;
  mount(root, h('header', null, h('h1', null, 'Platform overview'), h('span', { class: 'muted small' }, 'Last 30 days')),
    h('div', { class: 'grid g4' }, stat('Gross ticket sales', N(r.grossTicketSales), `${num(c.successfulTransactions)} paid orders`), stat('Platform commission (net)', N(r.platformCommissionNet), 'After reversals'), stat('Refunds', N(r.refunds)), stat('Gateway fees reported', N(r.gatewayFeesReported), 'As reported by provider'),
      stat('Users', num(c.users)), stat('Organizers', num(c.organizers)), stat('Events', num(c.events), `${c.published} live · ${c.draft} draft · ${c.suspended} suspended`), stat('Tickets sold (all time)', num(c.ticketsSold), `${c.failedPayments} failed payments`)),
    h('div', { class: 'grid g2', style: { marginTop: '16px' } }, h('div', { class: 'card' }, h('h3', null, 'Gross sales per day'), chart(fillDays(series, 'revenue', d.range.from, d.range.to), { label: 'Gross sales per day', fmt: N })), h('div', { class: 'card' }, h('h3', null, 'Commission per day'), chart(fillDays(series, 'commission', d.range.from, d.range.to), { color: 'var(--violet)', kind: 'bar', label: 'Commission per day', fmt: N }))),
    h('div', { class: 'grid g2', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('h3', null, 'Liabilities to organizers'), h('dl', { class: 'kv' }, h('dt', null, 'Owed (ledger)'), h('dd', null, N(l.owedToOrganizersLedger)), h('dt', null, 'Payouts requested'), h('dd', null, N(l.settlementsRequested)), h('dt', null, 'Payouts approved'), h('dd', null, N(l.settlementsApproved)), h('dt', null, `Paid out (${l.settlementsCompletedCount})`), h('dd', null, N(l.settlementsPaid)))),
      h('div', { class: 'card' }, h('h3', null, 'Recent admin activity'), h('div', { class: 'stack small' }, d.recentActivity.map((a) => h('div', { class: 'row between' }, h('span', null, `${a.action} · ${a.entityType}`), h('span', { class: 'muted' }, fmtDT(a.createdAt))))))),
    h('div', { class: 'card', style: { marginTop: '16px' } }, h('h4', null, 'Read this before trusting a number'), h('ul', null, d.notes.map((n) => h('li', null, n)))));
}

export async function users(root) {
  await pagedTable(root, { title: 'Users', url: '/api/admin/users', filters: [{ name: 'role', label: 'Role', options: ['CUSTOMER', 'ORGANIZER', 'ADMIN'] }, { name: 'status', label: 'Status', options: ['ACTIVE', 'SUSPENDED'] }], columns: [
    { label: 'User', render: (u) => h('div', null, h('strong', null, u.name), h('div', { class: 'small muted' }, u.email)) }, { label: 'Role', render: (u) => u.role.toLowerCase() }, { label: 'Status', render: (u) => statusBadge(u.status) },
    { label: 'Verified', render: (u) => (u.emailVerifiedAt ? 'Yes' : 'No') }, { label: 'Joined', render: (u) => fmtDT(u.createdAt) },
    { label: '', render: (u) => (u.role === 'ADMIN' ? '' : btn(u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate', async () => { const reason = await ask(u.status === 'ACTIVE' ? 'Suspend user' : 'Reactivate user', { label: 'Reason (audited)' }); if (!reason) return; await api.post(`/api/admin/users/${u.id}/status`, { status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE', reason }); toast('Updated', 'ok'); users(root); })) }] });
}

export async function organizers(root) {
  await pagedTable(root, { title: 'Organizers', url: '/api/admin/organizers', columns: [
    { label: 'Organizer', render: (o) => h('div', null, h('strong', null, o.brandName), h('div', { class: 'small muted' }, o.email)) }, { label: 'Status', render: (o) => (o.suspended ? statusBadge('SUSPENDED') : statusBadge('ACTIVE')) },
    { label: 'Payout details', render: (o) => (o.payoutDetailsSet ? 'Set' : 'Missing') }, { label: 'Available', num: true, render: (o) => N(o.balance.available) }, { label: 'Pending', num: true, render: (o) => N(o.balance.pending) }, { label: 'Paid out', num: true, render: (o) => N(o.balance.paidOut) },
    { label: '', render: (o) => h('div', { class: 'row' }, btn(o.suspended ? 'Reinstate' : 'Suspend', async () => { const reason = await ask(o.suspended ? 'Reinstate organizer' : 'Suspend organizer', { label: 'Reason (audited)' }); if (!reason) return; await api.post(`/api/admin/organizers/${o.id}/suspend`, { suspended: !o.suspended, reason }); toast('Updated', 'ok'); organizers(root); }),
      o.payoutDetailsSet && btn('View payout account', async () => { const p = await api.get(`/api/admin/organizers/${o.id}/payout-details`); modal({ title: 'Payout account (access is audited)', body: h('dl', { class: 'kv' }, Object.entries(p).map(([k, v]) => [h('dt', null, k), h('dd', null, String(v))]).flat()), actions: [{ label: 'Close', class: 'ghost' }] }); })) }] });
}

export async function events(root) {
  await pagedTable(root, { title: 'Events', url: '/api/admin/events', filters: [{ name: 'status', label: 'Status', options: ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'CANCELLED', 'SUSPENDED'] }], columns: [
    { label: 'Event', render: (e) => h('div', null, h('a', { href: `/e/${e.slug}`, target: '_blank', rel: 'noopener' }, e.title), e.featured && h('span', { class: 'badge info', style: { marginLeft: '6px' } }, 'featured'), e.moderationNote && h('div', { class: 'small muted' }, e.moderationNote)) },
    { label: 'Organizer', render: (e) => e.organizer?.brandName }, { label: 'Status', render: (e) => statusBadge(e.status) }, { label: 'Sold', num: true, render: (e) => num(e.ticketsSold) },
    { label: 'Commission', render: (e) => (e.commissionOverridePercent != null || e.commissionOverrideFixed != null ? `${e.commissionOverridePercent ?? '–'}% + ${e.commissionOverrideFixed ?? '0'}` : 'default') },
    { label: '', render: (e) => h('div', { class: 'row' },
      ...(e.status === 'SUSPENDED' ? [btn('Restore', () => mod(e, 'restore'))] : [btn('Suspend', () => mod(e, 'suspend', true))]), e.status === 'PUBLISHED' && btn('Unpublish', () => mod(e, 'unpublish', true)), btn(e.featured ? 'Unfeature' : 'Feature', () => mod(e, e.featured ? 'unfeature' : 'feature')),
      btn('Commission', () => commissionDialog(e))) }] });
  async function mod(e, action, needNote) { const note = needNote ? await ask(`${action} event`, { label: 'Reason (shown to the organizer)' }) : ''; if (needNote && !note) return; await api.post(`/api/admin/events/${e.id}/moderate`, { action, note: note || '' }); toast('Done', 'ok'); events(root); }
  function commissionDialog(e) {
    const p = h('input', { class: 'input', type: 'number', min: 0, max: 100, step: '0.01', value: e.commissionOverridePercent ?? '', placeholder: 'blank = default', 'aria-label': 'Percent' });
    const f = h('input', { class: 'input', type: 'number', min: 0, step: '0.01', value: e.commissionOverrideFixed ?? '', placeholder: 'blank = default', 'aria-label': 'Fixed per ticket' });
    modal({ title: `Commission override: ${e.title}`, body: h('div', null, h('p', { class: 'small muted' }, 'Applies to new orders only. Existing orders keep the rate they were created with.'), h('div', { class: 'field' }, h('label', null, 'Percent'), p), h('div', { class: 'field' }, h('label', null, 'Fixed fee per ticket (₦)'), f)), actions: [{ label: 'Cancel', class: 'ghost' }, { label: 'Save', class: 'coral', onClick: async ({ close }) => { try { await api.put(`/api/admin/events/${e.id}/commission`, { percent: p.value === '' ? null : Number(p.value), fixed: f.value === '' ? null : f.value }); toast('Saved', 'ok'); close(); events(root); } catch (er) { toastError(er); } } }] });
  }
}

export async function orders(root) {
  await pagedTable(root, { title: 'Orders & payments', url: '/api/admin/orders', filters: [{ name: 'status', label: 'Status', options: ['PENDING', 'PAID', 'NEEDS_REVIEW', 'FAILED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED'] }], columns: [
    { label: 'Order', render: (o) => h('div', null, h('strong', null, o.reference), h('div', { class: 'small muted' }, o.buyerEmail)) }, { label: 'Event', render: (o) => o.event }, { label: 'Status', render: (o) => statusBadge(o.status) },
    { label: 'Payment', render: (o) => (o.payment ? `${o.payment}${o.gatewayStatus ? ` / ${o.gatewayStatus}` : ''}` : '—') }, { label: 'Total', num: true, render: (o) => N(o.total) }, { label: 'Commission', num: true, render: (o) => N(o.commission) },
    { label: '', render: (o) => btn('Inspect', () => inspect(o.reference)) }] });
  async function inspect(ref) {
    const o = await api.get(`/api/admin/orders/${encodeURIComponent(ref)}`);
    const act = (label, action, cls = 'ghost') => ({ label, class: cls, onClick: async ({ close }) => { if (!(await confirmDialog(`${label} for order ${ref}?`, { danger: action === 'refund_full' }))) return; try { const r = await api.post(`/api/admin/orders/${encodeURIComponent(ref)}/resolve`, { action }); toast(`Result: ${r.outcome}`, 'ok'); close(); orders(root); } catch (e) { toastError(e); } } });
    modal({ title: `Order ${ref}`, body: h('div', null, h('dl', { class: 'kv' }, h('dt', null, 'Status'), h('dd', null, statusBadge(o.status)), h('dt', null, 'Total'), h('dd', null, N(o.total)), h('dt', null, 'Review note'), h('dd', null, o.reviewNote || '—'), h('dt', null, 'Payments'), h('dd', null, o.payments.map((p) => `${p.status} ${N(p.amount)} (${p.lastGatewayStatus || 'no gateway status'})`).join('; ') || '—'), h('dt', null, 'Tickets'), h('dd', null, o.tickets.map((t) => `${t.number} ${t.status}`).join(', ') || 'none'), h('dt', null, 'Ledger entries'), h('dd', null, String(o.ledger.length)), h('dt', null, 'Webhook events'), h('dd', null, o.webhookEvents.map((w) => `${w.type}:${w.status}`).join(', ') || 'none')), h('p', { class: 'small muted' }, '“Re-check payment” asks the gateway server-to-server. A refund is only recorded complete when the provider confirms it.')),
      actions: [{ label: 'Close', class: 'ghost' }, act('Re-check payment', 'recheck'), ['PAID', 'NEEDS_REVIEW'].includes(o.status) && act('Refund in full', 'refund_full', 'danger')].filter(Boolean) });
  }
}

export async function refunds(root) {
  const rows = await api.get('/api/admin/refunds');
  const reload = () => refunds(root);
  mount(root, h('header', null, h('h1', null, 'Refunds')), h('p', { class: 'muted small' }, 'A refund becomes COMPLETED only when the provider confirms it (signed webhook) or an admin records a provider reference. Manual completion is audited.'),
    rows.length ? table([{ label: 'Order', render: (r) => h('div', null, r.order.reference, h('div', { class: 'small muted' }, r.order.buyerEmail)) }, { label: 'Event', render: (r) => r.order.event.title }, { label: 'Amount', num: true, render: (r) => N(r.amount) }, { label: 'Status', render: (r) => statusBadge(r.status) }, { label: 'Reason', render: (r) => r.reason || '' }, { label: 'When', render: (r) => fmtDT(r.createdAt) },
      { label: '', render: (r) => h('div', { class: 'row' },
        r.status === 'REQUESTED' && btn('Approve', async () => { await api.post(`/api/admin/refunds/${r.id}/review`, { decision: 'approve' }); toast('Approved', 'ok'); reload(); }, 'coral'),
        r.status === 'REQUESTED' && btn('Reject', async () => { const note = await ask('Reject refund', { label: 'Reason' }); if (!note) return; await api.post(`/api/admin/refunds/${r.id}/review`, { decision: 'reject', note }); reload(); }),
        ['APPROVED', 'PROCESSING', 'FAILED'].includes(r.status) && btn('Retry', async () => { await api.post(`/api/admin/refunds/${r.id}/retry`); toast('Retried', 'ok'); reload(); }),
        ['APPROVED', 'PROCESSING', 'FAILED'].includes(r.status) && btn('Mark complete…', async () => { const reference = await ask('Complete manually', { label: 'Provider refund reference (required, audited)', multiline: false }); if (!reference) return; const note = await ask('Note', { label: 'Why is this being completed manually?' }); if (!note) return; await api.post(`/api/admin/refunds/${r.id}/complete-manually`, { reference, note }); toast('Recorded', 'ok'); reload(); })) }], rows) : empty('No refunds'));
}

export async function settlements(root) {
  const f = h('form', { novalidate: true, class: 'toolbar', onsubmit: async (e) => { e.preventDefault(); try { await submitting(f.querySelector('button'), async () => { await api.post('/api/admin/settlements', { organizerId: f.organizerId.value, amount: f.amount.value }); toast('Created', 'ok'); settlements(root); }); } catch (err) { formError(f, err); } } },
    h('div', { class: 'field' }, h('label', null, 'Organizer ID'), h('input', { class: 'input', name: 'organizerId', required: true })), h('div', { class: 'field' }, h('label', null, 'Amount (₦)'), h('input', { class: 'input', name: 'amount', type: 'number', step: '0.01', required: true })), h('button', { class: 'btn ghost', type: 'submit' }, 'Create payout on behalf'));
  const load = await pagedTable(root, { title: 'Payouts', url: '/api/admin/settlements', search: false, filters: [{ name: 'status', label: 'Status', options: ['REQUESTED', 'APPROVED', 'PAID', 'REJECTED'] }], extra: null, columns: [
    { label: 'Organizer', render: (s) => h('div', null, s.organizer.brandName, h('div', { class: 'small muted' }, `${s.organizer.payoutBankName || '—'} · ${s.organizer.payoutAccountName || ''} ••••${s.organizer.payoutAccountLast4 || ''}`)) }, { label: 'Amount', num: true, render: (s) => N(s.amount) }, { label: 'Status', render: (s) => statusBadge(s.status) }, { label: 'Requested', render: (s) => fmtDT(s.createdAt) }, { label: 'Reference', render: (s) => s.externalReference || '' },
    { label: '', render: (s) => h('div', { class: 'row' },
      s.status === 'REQUESTED' && btn('Approve', async () => { await api.post(`/api/admin/settlements/${s.id}/approve`); toast('Approved', 'ok'); settlements(root); }, 'coral'),
      ['REQUESTED', 'APPROVED'].includes(s.status) && btn('Reject', async () => { const note = await ask('Reject payout', { label: 'Reason (the amount returns to the organizer balance)' }); if (!note) return; await api.post(`/api/admin/settlements/${s.id}/reject`, { note }); settlements(root); }),
      s.status === 'APPROVED' && btn('Mark paid…', async () => { const externalReference = await ask('Mark as paid', { label: 'Bank transfer reference (after you have actually sent the money)', multiline: false }); if (!externalReference) return; await api.post(`/api/admin/settlements/${s.id}/paid`, { externalReference }); toast('Marked paid', 'ok'); settlements(root); })) }] });
  root.querySelector('header').after(h('p', { class: 'muted small' }, 'Payouts are manual: this app does not move money. Approve, send the transfer from your bank, then record the bank reference.'), f);
}

export async function reconciliation(root) {
  const d = await api.get('/api/admin/reconciliation');
  const sec = (title, rows, render) => h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h4', null, `${title} (${rows.length})`), rows.length ? h('ul', null, rows.map((r) => h('li', null, render(r)))) : h('p', { class: 'muted small' }, 'None found.'));
  mount(root, h('header', null, h('h1', null, 'Reconciliation'), btn('Run checks now', async () => { const r = await api.post('/api/admin/reconciliation/run'); toast(`Ran: ${JSON.stringify(r).slice(0, 80)}`, 'ok'); reconciliation(root); }, 'coral')),
    h('p', { class: 'muted small' }, 'Compares this app’s records for inconsistencies. It does not read your Bachs balance: check the Bachs dashboard for that.'),
    sec('Paid orders without tickets', d.paidNoTickets, (r) => r.reference), sec('Succeeded payment but order not paid', d.succeededOrderNotPaid, (r) => `payment ${r.id} · order ${r.orderId}`),
    sec('Orders needing review', d.needsReview, (r) => `${r.reference}: ${r.reviewNote || 'no note'} (since ${fmtDT(r.updatedAt)})`), sec('Failed webhook events', d.failedWebhooks, (r) => `${r.type} · ${r.eventId} · attempts ${r.attempts} · ${r.error || ''}`), sec('Reservation mismatches', d.reservationMismatches, (r) => `${r.name}: counter ${r.quantityReserved} vs held ${r.held}`));
}

export async function moderation(root) {
  const holder = h('div', null);
  mount(root, h('header', null, h('h1', null, 'Moderation & support')), holder);
  const [reports, appeals, support] = await Promise.all([api.get('/api/admin/reports?status=OPEN&pageSize=50').catch(() => []), api.get('/api/admin/appeals?pageSize=50'), api.get('/api/admin/support?pageSize=50')]);
  mount(holder,
    h('h3', null, 'Event reports'), reports.length ? table([{ label: 'Event', render: (r) => r.event.title }, { label: 'Reason', render: (r) => `${r.reason}${r.details ? `: ${r.details}` : ''}` }, { label: 'By', render: (r) => r.reporter?.email || 'guest' }, { label: '', render: (r) => h('div', { class: 'row' }, ['REVIEWING', 'ACTIONED', 'DISMISSED'].map((s) => btn(s.toLowerCase(), async () => { const resolution = s === 'REVIEWING' ? '' : await ask('Resolution note', { label: 'Note', multiline: false }); await api.post(`/api/admin/reports/${r.id}/resolve`, { status: s, resolution: resolution || undefined }); moderation(root); }))) }], reports) : empty('No open reports'),
    h('h3', { style: { marginTop: '24px' } }, 'Appeals'), appeals.length ? table([{ label: 'Event', render: (a) => a.event.title }, { label: 'Moderation note', render: (a) => a.event.moderationNote || '' }, { label: 'Appeal', render: (a) => a.message }, { label: 'Status', render: (a) => statusBadge(a.status) }, { label: '', render: (a) => a.status === 'OPEN' && h('div', { class: 'row' }, ['uphold', 'dismiss'].map((d) => btn(d === 'uphold' ? 'Lift suspension' : 'Dismiss appeal', async () => { const response = await ask('Response to organizer', { label: 'Response' }); if (!response) return; await api.post(`/api/admin/appeals/${a.id}/decide`, { decision: d, response }); moderation(root); }))) }], appeals) : empty('No appeals'),
    h('h3', { style: { marginTop: '24px' } }, 'Support requests'), support.length ? table([{ label: 'From', render: (s) => s.email || s.userId }, { label: 'Subject', render: (s) => h('div', null, h('strong', null, s.subject), h('div', { class: 'small prose' }, s.message)) }, { label: 'Status', render: (s) => statusBadge(s.status) }, { label: 'Date', render: (s) => fmtDT(s.createdAt) }, { label: '', render: (s) => s.status !== 'RESOLVED' && btn('Reply', async () => { const reply = await ask('Reply (emailed to the requester)', { label: 'Reply' }); if (!reply) return; await api.post(`/api/admin/support/${s.id}/reply`, { reply }); moderation(root); }) }], support) : empty('No support requests'));
}

export async function reports(root) {
  const from = h('input', { class: 'input', type: 'date', 'aria-label': 'From' }), to = h('input', { class: 'input', type: 'date', 'aria-label': 'To' });
  const out = h('div', null);
  const range = () => qs({ from: from.value ? new Date(from.value).toISOString() : '', to: to.value ? new Date(`${to.value}T23:59:59`).toISOString() : '' });
  async function run() { const rows = await api.get(`/api/admin/reports/commission${range()}`); mount(out, rows.length ? table([{ label: 'Organizer', render: (r) => r.brandName }, { label: 'Event', render: (r) => r.title }, { label: 'Orders', num: true, render: (r) => num(r.orders) }, { label: 'Gross', num: true, render: (r) => N(r.gross) }, { label: 'Refunded', num: true, render: (r) => N(r.refunded) }, { label: 'Commission (net)', num: true, render: (r) => N(r.commissionNet) }, { label: 'Organizer net', num: true, render: (r) => N(r.organizerNet) }], rows) : empty('No sales in this range')); }
  mount(root, h('header', null, h('h1', null, 'Commission reports')), h('div', { class: 'toolbar' }, from, to, btn('Run report', run, 'coral'), h('a', { class: 'btn ghost sm', href: '#/reports', onclick: (e) => { e.currentTarget.href = `/api/admin/reports/commission.csv${range()}`; } }, 'Download commission CSV'), h('a', { class: 'btn ghost sm', href: '#/reports', onclick: (e) => { e.currentTarget.href = `/api/admin/reports/ledger.csv${range()}`; } }, 'Download ledger CSV')), out);
  await run();
}

export async function audit(root) {
  await pagedTable(root, { title: 'Audit log', url: '/api/admin/audit', search: false, pageSize: 30, columns: [{ label: 'When', render: (a) => fmtDT(a.createdAt) }, { label: 'Action', render: (a) => a.action }, { label: 'Entity', render: (a) => `${a.entityType}${a.entityId ? ` · ${a.entityId.slice(0, 8)}` : ''}` }, { label: 'Actor', render: (a) => `${a.actorRole || ''} ${a.actorId ? a.actorId.slice(0, 8) : 'system'}` }, { label: 'Change', render: (a) => h('code', { class: 'small' }, JSON.stringify({ before: a.before, after: a.after }).slice(0, 140)) }] });
}

export async function settings(root) {
  const { settings: s, categories, payments } = await api.get('/api/admin/settings');
  const anns = await api.get('/api/admin/announcements');
  const num$ = (name, label, props = {}) => h('div', { class: 'field' }, h('label', null, label), h('input', { class: 'input', name, type: 'number', step: 'any', value: s[name], ...props }));
  const txt = (name, label, type = 'text') => h('div', { class: 'field' }, h('label', null, label), h('input', { class: 'input', name, type, value: s[name] ?? '' }));
  const chk = (name, label) => h('label', { class: 'check field' }, h('input', { type: 'checkbox', name, checked: Boolean(s[name]) }), label);
  const f = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const v = (n) => f[n].value; const c = (n) => f[n].checked;
    const body = { platformName: v('platformName'), supportEmail: v('supportEmail'), supportPhone: v('supportPhone'), commissionPercent: Number(v('commissionPercent')), commissionFixedPerTicket: Number(v('commissionFixedPerTicket')), allowEventCommissionOverride: c('allowEventCommissionOverride'), reservationMinutes: Number(v('reservationMinutes')), settlementHoldDays: Number(v('settlementHoldDays')), maxTicketsPerOrder: Number(v('maxTicketsPerOrder')), guestCheckout: c('guestCheckout'), maintenanceMode: c('maintenanceMode'), requireVerifiedEmailToPublish: c('requireVerifiedEmailToPublish'), featureWaitlist: c('featureWaitlist'), featureDiscountCodes: c('featureDiscountCodes') };
    try { await submitting(f.querySelector('button[type=submit]'), async () => { await api.patch('/api/admin/settings', body); toast('Settings saved. Commission changes apply to new orders only.', 'ok'); }); } catch (err) { formError(f, err); }
  } }, h('div', { class: 'grid g3' }, txt('platformName', 'Platform name'), txt('supportEmail', 'Support email', 'email'), txt('supportPhone', 'Support phone')),
    h('div', { class: 'grid g3' }, num$('commissionPercent', 'Commission % of each ticket', { min: 0, max: 100 }), num$('commissionFixedPerTicket', 'Fixed commission per paid ticket (₦)', { min: 0 }), num$('settlementHoldDays', 'Payout hold after event end (days)', { min: 0, max: 60 })),
    h('div', { class: 'grid g3' }, num$('reservationMinutes', 'Ticket hold while paying (minutes)', { min: 5, max: 60 }), num$('maxTicketsPerOrder', 'Max tickets per order', { min: 1, max: 100 })),
    h('div', { class: 'grid g2' }, chk('allowEventCommissionOverride', 'Allow per-event commission overrides'), chk('guestCheckout', 'Allow guest checkout'), chk('requireVerifiedEmailToPublish', 'Require verified email to publish'), chk('featureWaitlist', 'Waitlists enabled'), chk('featureDiscountCodes', 'Discount codes enabled'), chk('maintenanceMode', 'Maintenance mode (pauses ticket sales)')),
    h('button', { class: 'btn coral', type: 'submit' }, 'Save settings'));
  const catName = h('input', { class: 'input', placeholder: 'New category name', 'aria-label': 'New category' });
  const annT = h('input', { class: 'input', placeholder: 'Title', 'aria-label': 'Title' }), annB = h('input', { class: 'input', placeholder: 'Message', 'aria-label': 'Message' });
  mount(root, h('header', null, h('h1', null, 'Settings')),
    h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h3', null, 'Payments status'), h('dl', { class: 'kv' }, h('dt', null, 'Driver'), h('dd', null, payments.driver), h('dt', null, 'Mode'), h('dd', null, payments.mode), h('dt', null, 'API key'), h('dd', null, payments.configured ? 'Configured' : 'Missing (BACHS_API_KEY)'), h('dt', null, 'Webhook secret'), h('dd', null, payments.webhookSecretConfigured ? 'Configured' : 'Missing (BACHS_WEBHOOK_SECRET)'), h('dt', null, 'Can take payments'), h('dd', null, payments.canTakePayments ? 'Yes' : 'No'))),
    h('div', { class: 'card' }, h('h3', null, 'Platform & commission'), f),
    h('div', { class: 'grid g2', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('h3', null, 'Categories'), h('ul', null, categories.map((c) => h('li', null, c.name, ' ', btn(c.active ? 'Hide' : 'Show', async () => { await api.patch(`/api/admin/categories/${c.id}`, { active: !c.active }); settings(root); })))), h('div', { class: 'row' }, catName, btn('Add', async () => { if (!catName.value.trim()) return; await api.post('/api/admin/categories', { name: catName.value }); settings(root); }, 'coral'))),
      h('div', { class: 'card' }, h('h3', null, 'Announcements'), h('ul', null, anns.map((a) => h('li', null, `${a.title}: ${a.body} `, btn(a.active ? 'Deactivate' : 'Activate', async () => { await api.patch(`/api/admin/announcements/${a.id}`, { active: !a.active }); settings(root); })))), h('div', { class: 'stack' }, annT, annB, btn('Publish announcement', async () => { await api.post('/api/admin/announcements', { title: annT.value, body: annB.value, active: true }); settings(root); }, 'coral')))));
}

export async function system(root) {
  const [sys, log] = await Promise.all([api.get('/api/admin/system'), api.get('/api/admin/email/log')]);
  mount(root, h('header', null, h('h1', null, 'System & email')),
    h('div', { class: 'grid g3' }, h('div', { class: 'card' }, h('h4', null, 'Payments'), h('dl', { class: 'kv' }, Object.entries(sys.payments).map(([k, v]) => [h('dt', null, k), h('dd', null, String(v))]).flat())), h('div', { class: 'card' }, h('h4', null, 'Email queue'), h('dl', { class: 'kv' }, Object.entries(sys.email).map(([k, v]) => [h('dt', null, k), h('dd', null, String(v))]).flat()), h('div', { class: 'row', style: { marginTop: '8px' } }, btn('Retry failed', async () => { const r = await api.post('/api/admin/email/retry-failed'); toast(`${r.requeued} requeued`, 'ok'); system(root); }), btn('Send test email to me', async () => { const r = await api.post('/api/admin/email/test'); toast(`Processed: ${JSON.stringify(r)}`, 'ok'); system(root); }))), h('div', { class: 'card' }, h('h4', null, 'Webhook events'), h('dl', { class: 'kv' }, sys.webhooks.map((w) => [h('dt', null, w.status), h('dd', null, String(w._count))]).flat()))),
    h('h3', { style: { marginTop: '24px' } }, 'Recent email'), log.length ? table([{ label: 'To', render: (m) => m.toEmail }, { label: 'Subject', render: (m) => m.subject }, { label: 'Status', render: (m) => statusBadge(m.status) }, { label: 'Tries', num: true, render: (m) => m.attempts }, { label: 'Error', render: (m) => m.lastError || '' }, { label: 'Queued', render: (m) => fmtDT(m.createdAt) }], log) : empty('No email yet'));
}
