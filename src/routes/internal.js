// Scheduler endpoints for hosts without a persistent worker (serverless, or an external cron).
// Protected by a bearer secret (CRON_SECRET), compared in constant time.
import { Router } from 'express';
import { config } from '../config/env.js';
import { asyncHandler, AppError } from '../lib/errors.js';
import { safeEqual } from '../utils/crypto.js';
import { TASKS, runTask } from '../jobs/tasks.js';

const router = Router();

router.use((req, res, next) => {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!config.CRON_SECRET || !given || !safeEqual(given, config.CRON_SECRET)) return next(new AppError(401, 'UNAUTHORIZED', 'Invalid cron credentials'));
  next();
});

// Vercel Cron calls with GET (and sends `Authorization: Bearer $CRON_SECRET`); external schedulers can use POST.
router.all('/cron/:task', asyncHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST');
  const name = req.params.task;
  if (name !== 'all' && !TASKS[name]) throw new AppError(404, 'UNKNOWN_TASK', 'Unknown task');
  const result = name === 'all' ? await (await import('../jobs/tasks.js')).runAll() : await runTask(name);
  res.json({ ok: true, data: result });
}));

export default router;