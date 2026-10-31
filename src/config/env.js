import 'dotenv/config';
import { z } from 'zod';

// Load ./.env explicitly (Node >= 20.12). Variables already set in the real environment win over the file.
try { process.loadEnvFile?.('.env'); } catch { /* no .env file: rely on real environment variables */ }

const bool = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v), z.boolean());
const emptyToUndef = (v) => (v === '' ? undefined : v);
const optStr = z.preprocess(emptyToUndef, z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  // Extra browser origins allowed to call the API (comma separated), e.g. http://localhost:3000 while APP_URL is a tunnel. Leave empty in production.
  ALLOWED_ORIGINS: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(336),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),

  PAYMENTS_DRIVER: z.enum(['bachs', 'mock']).default('bachs'),
  BACHS_API_KEY: optStr,
  BACHS_WEBHOOK_SECRET: optStr,
  BACHS_WEBHOOK_SECRET_PREVIOUS: optStr,
  BACHS_LIVE_ENABLED: bool.default(false),
  // Paths are overridable because they could not be confirmed against docs.bachs.io (see docs/PAYMENTS.md).
  BACHS_CHECKOUT_PATH: z.string().default('/v1/checkout-sessions'),
  BACHS_VERIFY_PATH: z.string().default('/v1/checkout-sessions/{id}'),
  BACHS_REFUND_PATH: z.string().default('/v1/refunds'),

  PLATFORM_NAME: z.string().default('EventHub'),
  PLATFORM_COMMISSION_PERCENT: z.coerce.number().min(0).max(100).default(5),
  PLATFORM_COMMISSION_FIXED_PER_TICKET: z.coerce.number().min(0).default(0),

  SMTP_HOST: optStr,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: optStr,
  SMTP_PASS: optStr,
  SMTP_FROM: z.string().default('EventHub <no-reply@example.com>'),

  ADMIN_EMAIL: optStr,
  ADMIN_PASSWORD: optStr,

  CRON_SECRET: optStr,
  RUN_WORKER_IN_PROCESS: bool.default(true),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_UPLOAD_DIR: z.string().default('./uploads'),
  S3_BUCKET: optStr,
  S3_REGION: optStr,
  S3_ENDPOINT: optStr,
  S3_ACCESS_KEY_ID: optStr,
  S3_SECRET_ACCESS_KEY: optStr,
  S3_PUBLIC_BASE_URL: optStr,
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';

  if (env.PAYMENTS_DRIVER === 'mock' && isProd) throw new Error('PAYMENTS_DRIVER=mock is not allowed in production');
  if (isProd && env.STORAGE_DRIVER === 'local') {
    console.warn('[config] STORAGE_DRIVER=local in production: uploads will be lost on ephemeral hosts. Use s3.');
  }
  if (isProd && !env.APP_URL.startsWith('https://')) throw new Error('APP_URL must be https:// in production');
  if (env.BACHS_API_KEY?.startsWith('sk_live_') && !env.BACHS_LIVE_ENABLED) {
    // Live key present but not explicitly enabled: payments service refuses to start live mode.
    console.warn('[config] Live Bachs key configured but BACHS_LIVE_ENABLED is not true; live payments stay disabled.');
  }

  return Object.freeze({
    ...env,
    isProd,
    isTest: env.NODE_ENV === 'test',
    bachsMode: env.BACHS_API_KEY?.startsWith('sk_live_') ? 'live' : env.BACHS_API_KEY?.startsWith('sk_sandbox_') ? 'sandbox' : null,
  });
}

export const config = load();