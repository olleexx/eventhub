import { Router, raw } from 'express';
import { asyncHandler } from '../lib/errors.js';
import { handleBachsWebhook } from '../services/webhooks.js';

const router = Router();

// RAW body required: the signature is computed over the exact bytes Bachs sent.
router.post('/bachs', raw({ type: '*/*', limit: '256kb' }), asyncHandler(async (req, res) => {
  const outcome = await handleBachsWebhook({ rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(''), headers: req.headers });
  res.status(200).json({ received: true, duplicate: Boolean(outcome.duplicate) });
}));

export default router;
