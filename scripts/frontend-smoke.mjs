import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PUB = new URL('../public', import.meta.url).pathname;
const card = { id: 'e1', slug: 'fest', title: 'Test Fest', startsAt: new Date(Date.now()+864e5*5).toISOString(), endsAt: new Date(Date.now()+864e5*5+36e5).toISOString(), timezone: 'Africa/Lagos', venueName: 'Hall', city: 'Lagos', minPrice: '5000', isFree: false, currency: 'NGN', category: { name: 'Music' }, organizer: { brandName: 'Olu' }, ticketsRemaining: 5, lowStock: true, soldOut: false, bannerUrl: null };
const ev = { ...card, status: 'PUBLISHED', description: 'Desc <script>alert(1)</script>', shortDescription: 'short', images: [], ticketTypes: [{ id: 't1', name: 'General', description: 'd', price: '5000.00', minPerOrder: 1, maxPerOrder: 10, state: 'ON_SALE', remaining: 5 }], organizer: { brandName: 'Olu' }, customQuestions: [{ id: 'size', label: 'Size', type: 'select', required: true, options: ['S','M'] }], refundPolicy: 'r', favorited: false, waitlistEnabled: true, discountsEnabled: true, mapUrl: null, onlineUrl: null };
const user = { id: 'u1', name: 'Test User', email: 't@e.st', role: 'ADMIN', emailVerified: true, isOrganizer: true, organizer: { id: 'o1', brandName: 'Olu' } };
const series = [{ day: new Date().toISOString().slice(0,10), revenue: '1000', commission: '50', orders: 1, tickets: 2 }];
const totals = { gross: '1000', net: '900', commission: '50', refunds: '0', orders: 1, ticketsIssued: 2, ticketsUsed: 1, refundCount: 0, pendingAmount: '0', pendingOrders: 0 };
const routes = {
  '/api/auth/me': { user, csrfToken: 'c', settings: { platformName: 'EventHub', currency: 'NGN', supportEmail: 's@e.st', featureDiscountCodes: true }, announcements: [] },
  '/api/home': { featured: [card], trending: [card], upcoming: [card], newlyPublished: [], limited: [card], nearYou: [], categories: [{ id: 'c', name: 'Music', slug: 'music', count: 1 }], cities: [] },
  '/api/categories': [{ id: 'c', name: 'Music', slug: 'music' }],
  '/api/events': [card], '/api/events/fest': ev,
  '/api/orders/ORD1': { reference: 'ORD1', status: 'PAID', total: '5000', currency: 'NGN', refundedTotal: '0', items: [{ name: 'General', quantity: 1, unitPrice: '5000', lineTotal: '5000' }], event: card, tickets: [{ id: 't', number: 'EH-AAAA-BBBB', status: 'VALID', type: 'General', qr: 'data:image/png;base64,iVBORw0KGgo=' }], refunds: [], canRequestRefund: true },
  '/api/me/tickets': [], '/api/me/orders': [], '/api/me/favorites': [],
  '/api/organizer/overview': { range: { from: new Date(Date.now()-30*864e5).toISOString(), to: new Date().toISOString() }, totals, ticketsRemaining: 5, series, settlements: { available: '900', pending: '0' }, upcoming: [{ id: 'e1', title: 'Test Fest', startsAt: card.startsAt, ticketsSold: 2 }], recentOrders: [{ reference: 'ORD1', buyerName: 'B', total: '5000', status: 'PAID', event: { title: 'Test Fest' } }], definitions: { net: 'x' } },
  '/api/organizer/events': [{ id: 'e1', slug: 'fest', title: 'Test Fest', status: 'PUBLISHED', startsAt: card.startsAt, ticketsSold: 2, ticketsRemaining: 5, myRole: 'OWNER' }],
  '/api/organizer/categories': [{ id: 'c', name: 'Music' }],
  '/api/organizer/events/e1': { event: { ...ev, id: 'e1', refundDeadline: null, categoryId: 'c' }, ticketTypes: [{ id: 't1', name: 'General', price: '5000.00', quantityTotal: 10, quantitySold: 2, quantityReserved: 0, minPerOrder: 1, maxPerOrder: 10, remaining: 8 }], images: [], discounts: [], permissions: { manage: true, finance: true, staff: true, scan: true, attendees: true, publish: true, view: true } },
  '/api/organizer/events/e1/analytics': { tickets: [{ id: 't1', name: 'General', price: '5000', total: 10, sold: 2, reserved: 0, remaining: 8 }], checkin: { admitted: 1, valid: 1, rate: .5 }, peakHours: [{ hour: 10, orders: 1 }], series, totals, bySource: [] },
  '/api/organizer/events/e1/checklist': { ok: false, checks: [{ key: 'a', label: 'A', ok: true }, { key: 'b', label: 'B', ok: false }] },
  '/api/organizer/orders': [], '/api/organizer/refunds': [],
  '/api/organizer/finance': { balance: { available: '900', pending: '0', settlementsRequested: '0', settlementsApproved: '0', paidOut: '0' }, explanation: 'e', payoutDetails: {}, settlements: [] },
  '/api/organizer/scannable-events': [{ id: 'e1', title: 'Test Fest', startsAt: card.startsAt }], '/api/checkin/e1/stats': { admitted: 1, remainingValid: 1, total: 2, recent: [] },
  '/api/admin/overview': { range: { from: new Date(Date.now()-30*864e5).toISOString(), to: new Date().toISOString() }, counts: { users: 1, organizers: 1, events: 1, published: 1, draft: 0, suspended: 0, ticketsSold: 2, successfulTransactions: 1, failedPayments: 0 }, recordedRevenue: { grossTicketSales: '1000', refunds: '0', platformCommissionNet: '50', gatewayFeesReported: '0' }, liabilities: { owedToOrganizersLedger: '900', settlementsRequested: '0', settlementsApproved: '0', settlementsPaid: '0', settlementsCompletedCount: 0 }, notes: ['n'], recentActivity: [] },
  '/api/admin/overview/series': series, '/api/admin/users': [{ id: 'u', name: 'N', email: 'e', role: 'CUSTOMER', status: 'ACTIVE', createdAt: new Date().toISOString() }],
  '/api/admin/settings': { settings: { platformName: 'E', supportEmail: 'a@b.c', supportPhone: '', commissionPercent: 5, commissionFixedPerTicket: 0, settlementHoldDays: 3, reservationMinutes: 15, maxTicketsPerOrder: 10 }, categories: [], payments: { driver: 'mock', mode: 'mock', configured: true, webhookSecretConfigured: true, canTakePayments: true } }, '/api/admin/announcements': [],
  '/api/admin/system': { payments: {}, email: {}, webhooks: [] }, '/api/admin/email/log': [], '/api/admin/reconciliation': { paidNoTickets: [], succeededOrderNotPaid: [], needsReview: [], failedWebhooks: [], reservationMismatches: [] }, '/api/admin/refunds': [], '/api/admin/reports/commission': [], '/api/admin/audit': [],
};
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p.startsWith('/api/')) { const d = routes[p]; if (d === undefined) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: { message: 'stub 404 ' + p } })); } res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, data: d, ...(Array.isArray(d) ? { meta: { page: 1, pageSize: 20, total: d.length, totalPages: 1 } } : {}) })); }
  let f = p === '/' ? '/index.html' : p; if (p.startsWith('/e/')) f = '/event.html'; else if (p.startsWith('/orders/')) f = '/order.html'; else if (!path.extname(f)) f += '.html';
  const fp = path.join(PUB, f); if (!fp.startsWith(PUB) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf ' + f); }
  const t = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(fp)] || 'application/octet-stream'; res.writeHead(200, { 'content-type': t }); res.end(fs.readFileSync(fp));
});
await new Promise((r) => srv.listen(0, r)); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(); let failed = 0;
const pages = ['/', '/events', '/e/fest', '/login', '/register', '/forgot', '/reset-password?token=abc', '/verify-email', '/account', '/contact', '/terms', '/orders/ORD1', '/organizer', '/organizer#/events', '/organizer#/events/e1', '/organizer#/events/e1/attendees', '/organizer#/events/e1/edit/tickets', '/organizer#/events/e1/edit/publish', '/organizer#/events/new', '/organizer#/finance', '/organizer#/orders', '/organizer#/refunds', '/organizer#/profile', '/admin', '/admin#/users', '/admin#/settings', '/admin#/system', '/admin#/reconciliation', '/admin#/refunds', '/admin#/reports', '/admin#/audit', '/scan'];
for (const p of pages) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } }); const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', (e) => errs.push('pageerror: ' + e.message)); pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await pg.goto(base + p, { waitUntil: 'networkidle' }).catch((e) => errs.push('goto: ' + e.message)); await pg.waitForTimeout(250);
  const info = await pg.evaluate(() => ({ h1: document.querySelector('h1,h2')?.textContent?.slice(0, 40), spinner: !!document.querySelector('.spinner'), overflow: document.documentElement.scrollWidth > innerWidth + 1, xss: !!window.__xss }));
  const bad = errs.length || info.overflow || info.xss || (info.spinner && !['/verify-email'].includes(p));
  if (bad) failed++;
  console.log(bad ? 'FAIL' : 'ok  ', p.padEnd(40), JSON.stringify(info), errs.join(' | ').slice(0, 300));
  await ctx.close();
}
await browser.close(); srv.close(); console.log(failed ? `${failed} page(s) with problems` : 'all pages loaded without JS errors'); process.exit(failed ? 1 : 0);
