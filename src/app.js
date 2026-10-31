import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { asyncHandler } from './lib/errors.js';
import { securityHeaders, apiLimiter } from './middleware/security.js';
import { sessionMiddleware } from './middleware/session.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { paymentsStatus } from './services/payments/index.js';
import { getSettings } from './services/settings.js';
import { esc } from './templates/emails.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import orderRoutes from './routes/orders.js';
import organizerRoutes from './routes/organizer.js';
import checkinRoutes from './routes/checkin.js';
import adminRoutes from './routes/admin.js';
import webhookRoutes from './routes/webhooks.js';
import internalRoutes from './routes/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const absUrl = (p) => (p?.startsWith('http') ? p : `${config.APP_URL.replace(/\/$/, '')}${p ?? ''}`);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(securityHeaders);

  // Health checks (no auth, no secrets).
  app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
  app.get('/health', asyncHandler(async (req, res) => {
    let db = 'ok';
    try { await prisma.$queryRaw`SELECT 1`; } catch { db = 'down'; }
    const p = paymentsStatus();
    res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', db, payments: { mode: p.mode, canTakePayments: p.canTakePayments } });
  }));

  // Webhooks and cron: BEFORE json parsing and CSRF (raw body + their own authentication).
  app.use('/webhooks', webhookRoutes);
  app.use('/internal', internalRoutes);

  // Static assets. Uploaded images (local driver only) are served from /uploads with a strict type.
  if (config.STORAGE_DRIVER === 'local') {
    app.use('/uploads', express.static(path.resolve(config.LOCAL_UPLOAD_DIR), { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
  }
  app.use('/vendor/html5-qrcode', express.static(path.resolve(here, '../node_modules/html5-qrcode'), { maxAge: '7d', index: false }));
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0, index: 'index.html' }));

  // ---- API
  app.use('/api', apiLimiter, express.json({ limit: '100kb' }), sessionMiddleware, csrfProtection);
  app.use('/api/auth', authRoutes);
  app.use('/api', publicRoutes); // /api/home, /api/events, /api/categories, /api/support ...
  app.use('/api', orderRoutes);
  app.use('/api/organizer', organizerRoutes);
  app.use('/api/checkin', checkinRoutes);
  app.use('/api/admin', adminRoutes);

  // ---- Pages with server-side content
  let eventTemplate;
  const tpl = () => (eventTemplate ??= fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8'));
  app.get('/e/:slug', sessionMiddleware, asyncHandler(async (req, res) => {
    const slug = String(req.params.slug).slice(0, 120);
    const e = await prisma.event.findUnique({ where: { slug }, select: { title: true, shortDescription: true, description: true, bannerUrl: true, startsAt: true, endsAt: true, venueName: true, city: true, address: true, status: true, onlineUrl: true, minPrice: true, currency: true, organizer: { select: { brandName: true } } } });
    const settings = await getSettings();
    let seo = `<title>Event not found · ${esc(settings.platformName)}</title><meta name="robots" content="noindex">`;
    if (e && ['PUBLISHED', 'CANCELLED'].includes(e.status)) {
      const desc = esc((e.shortDescription || e.description || '').slice(0, 200));
      const img = e.bannerUrl ? absUrl(e.bannerUrl) : '';
      const url = `${config.APP_URL.replace(/\/$/, '')}/e/${slug}`;
      const ld = {
        '@context': 'https://schema.org', '@type': 'Event', name: e.title, description: (e.shortDescription || '').slice(0, 300), startDate: e.startsAt?.toISOString(), endDate: e.endsAt?.toISOString(),
        eventStatus: e.status === 'CANCELLED' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled',
        eventAttendanceMode: e.onlineUrl && !e.venueName ? 'https://schema.org/OnlineEventAttendanceMode' : 'https://schema.org/OfflineEventAttendanceMode',
        location: e.venueName ? { '@type': 'Place', name: e.venueName, address: [e.address, e.city].filter(Boolean).join(', ') } : undefined,
        image: img || undefined, organizer: { '@type': 'Organization', name: e.organizer.brandName },
        offers: e.minPrice != null ? { '@type': 'Offer', price: e.minPrice.toString(), priceCurrency: e.currency, url, availability: 'https://schema.org/InStock' } : undefined,
      };
      seo = `<title>${esc(e.title)} · ${esc(settings.platformName)}</title><meta name="description" content="${desc}"><link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(e.title)}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${esc(url)}">${img ? `<meta property="og:image" content="${esc(img)}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(e.title)}"><meta name="twitter:description" content="${desc}">${img ? `<meta name="twitter:image" content="${esc(img)}">` : ''}
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
    } else if (e) seo = `<title>${esc(e.title)} (preview)</title><meta name="robots" content="noindex">`;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.type('html').send(tpl().replace('<!--SEO-->', seo));
  }));

  const sendPage = (file) => (req, res) => res.sendFile(path.join(publicDir, file));
  app.get('/orders/:reference', sendPage('order.html'));
  app.get(['/organizer', '/organizer/*'], sendPage('organizer.html'));
  app.get(['/admin', '/admin/*'], sendPage('admin.html'));

  app.get('/robots.txt', (req, res) => res.type('text').send(`User-agent: *\nDisallow: /api/\nDisallow: /organizer\nDisallow: /admin\nDisallow: /orders/\nSitemap: ${config.APP_URL.replace(/\/$/, '')}/sitemap.xml\n`));
  app.get('/sitemap.xml', asyncHandler(async (req, res) => {
    const rows = await prisma.event.findMany({ where: { status: 'PUBLISHED', endsAt: { gte: new Date() } }, select: { slug: true, updatedAt: true }, orderBy: { startsAt: 'asc' }, take: 5000 });
    const base = config.APP_URL.replace(/\/$/, '');
    res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/events</loc></url>${rows.map((r) => `<url><loc>${base}/e/${esc(r.slug)}</loc><lastmod>${r.updatedAt.toISOString()}</lastmod></url>`).join('')}</urlset>`);
  }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// Default export for hosts that load this file directly as the entry (Vercel detects src/app.js and requires a
// default export that is a function). Builds the app on first request; the named createApp() above is unchanged.
let cachedApp;
export default function handler(req, res) {
  cachedApp ??= createApp();
  return cachedApp(req, res);
}