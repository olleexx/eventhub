import { config } from './config/env.js';
import { createApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { log } from './lib/logger.js';
import { startWorker } from './jobs/worker.js';
import { ensureDefaultCategories } from './services/categories.js';
import { paymentsStatus } from './services/payments/index.js';

const app = createApp();

async function main() {
  await prisma.$connect();
  await ensureDefaultCategories();
  const p = paymentsStatus();
  if (!p.canTakePayments) log.warn('payments_not_ready', { mode: p.mode, configured: p.configured, webhookSecret: p.webhookSecretConfigured, liveEnabled: p.liveEnabled });

  const server = app.listen(config.PORT, () => {
    log.info('listening', { port: config.PORT, env: config.NODE_ENV, paymentsMode: p.mode, appUrl: config.APP_URL });
    if (p.driver === 'bachs' && /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(config.APP_URL)) {
      log.warn('app_url_is_localhost', { hint: 'Bachs rejects localhost return URLs and cannot deliver webhooks to it. Run a tunnel (e.g. ngrok http 3000), set APP_URL to its https URL in .env, fully restart (Ctrl+C then npm run dev) and browse the site through that URL.' });
    }
  });
  const worker = config.RUN_WORKER_IN_PROCESS ? startWorker() : null;

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    log.info('shutting_down', { signal });
    worker?.stop();
    server.close(async () => { await prisma.$disconnect().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { err }));
}

main().catch((err) => { console.error(err); process.exit(1); });