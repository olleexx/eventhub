import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { ok, noStore } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { scanLimiter } from '../middleware/security.js';
import { scanTicket, checkinStats, undoCheckIn } from '../services/checkin.js';
import { scanBody } from '../validators/admin.js';
import { id } from '../validators/common.js';

const router = Router();
router.use(requireAuth);
const ev = z.object({ eventId: id });

router.post('/:eventId/scan', scanLimiter, validate({ params: ev, body: scanBody }), asyncHandler(async (req, res) => {
  noStore(res);
  ok(res, await scanTicket({ user: req.user, eventId: req.params.eventId, input: req.body.code, scanId: req.body.scanId, method: req.body.method }));
}));

router.get('/:eventId/stats', validate({ params: ev }), asyncHandler(async (req, res) => { noStore(res); ok(res, await checkinStats(req.user, req.params.eventId)); }));

router.post('/:eventId/undo/:ticketId', validate({ params: ev.extend({ ticketId: id }) }), asyncHandler(async (req, res) => ok(res, { undone: await undoCheckIn({ user: req.user, eventId: req.params.eventId, ticketId: req.params.ticketId, ip: req.ip }) })));

export default router;
