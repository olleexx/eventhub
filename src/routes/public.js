import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, unauthorized } from '../lib/errors.js';
import { ok, page } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';
import * as events from '../services/events.js';
import * as admin from '../services/admin.js';
import { listCategories } from '../services/categories.js';
import { previewDiscount } from '../services/checkout.js';
import { listQuery, reportBody } from '../validators/events.js';
import { discountPreviewBody, waitlistBody } from '../validators/checkout.js';
import { supportBody } from '../validators/admin.js';
import { id } from '../validators/common.js';

const router = Router();

router.get('/home', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  ok(res, await events.homeData({ city: typeof req.query.city === 'string' ? req.query.city.slice(0, 80) : undefined }));
}));

router.get('/categories', asyncHandler(async (req, res) => ok(res, await listCategories())));

router.get('/events', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const { total, items } = await events.listPublicEvents(q);
  page(res, items, total, q);
}));

router.get('/events/:slug', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-cache');
  ok(res, await events.getPublicEvent(String(req.params.slug).slice(0, 120), req.user));
}));

router.post('/discounts/preview', validate({ body: discountPreviewBody }), asyncHandler(async (req, res) => ok(res, await previewDiscount(req.body))));

router.post('/events/:eventId/waitlist', authLimiter, validate({ params: z.object({ eventId: id }), body: waitlistBody }), asyncHandler(async (req, res) => {
  await events.joinWaitlist({ eventId: req.params.eventId, ...req.body });
  ok(res, { joined: true });
}));

router.post('/events/:eventId/report', authLimiter, validate({ params: z.object({ eventId: id }), body: reportBody }), asyncHandler(async (req, res) => {
  await events.reportEvent(req.user, req.params.eventId, req.body);
  ok(res, { reported: true }, undefined, 201);
}));

router.put('/events/:eventId/favorite', requireAuth, validate({ params: z.object({ eventId: id }) }), asyncHandler(async (req, res) => ok(res, await events.toggleFavorite(req.user, req.params.eventId, true))));
router.delete('/events/:eventId/favorite', requireAuth, validate({ params: z.object({ eventId: id }) }), asyncHandler(async (req, res) => ok(res, await events.toggleFavorite(req.user, req.params.eventId, false))));

router.post('/support', authLimiter, validate({ body: supportBody }), asyncHandler(async (req, res) => {
  if (!req.user && !req.body.email) throw unauthorized('Provide an email address so we can reply', 'EMAIL_REQUIRED');
  await admin.createSupportRequest({ user: req.user, ...req.body });
  ok(res, { received: true }, undefined, 201);
}));

export default router;
