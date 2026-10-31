import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"], // no inline scripts anywhere in /public
      'style-src': ["'self'", "'unsafe-inline'"], // inline style attributes (banner gradients) only
      'img-src': ["'self'", 'data:', 'blob:', ...(config.S3_PUBLIC_BASE_URL ? [new URL(config.S3_PUBLIC_BASE_URL).origin] : [])],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // Camera is needed on the same origin for the QR scanner.
  permissionsPolicy: { features: { camera: ["'self'"], microphone: [], geolocation: [] } },
});

const json429 = (message) => (req, res) =>
  res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message } });

const common = { standardHeaders: true, legacyHeaders: false, skip: () => config.isTest };

export const apiLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 300, handler: json429('Too many requests, slow down.') });

export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 20,
  handler: json429('Too many attempts. Try again in a few minutes.'),
});

export const checkoutLimiter = rateLimit({ ...common, windowMs: 10 * 60_000, limit: 30, handler: json429('Too many checkout attempts. Try again shortly.') });

export const scanLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 240, handler: json429('Scanning too fast.') });

export const uploadLimiter = rateLimit({ ...common, windowMs: 10 * 60_000, limit: 60, handler: json429('Too many uploads.') });
