import { PrismaClient, Prisma } from '@prisma/client';
import { config } from '../config/env.js';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__prisma ??
  new PrismaClient({ log: config.isProd ? ['error'] : ['error', 'warn'] });

if (!config.isProd) globalForPrisma.__prisma = prisma;

export { Prisma };

/** Run fn inside an interactive transaction with sensible timeouts. */
export function tx(fn, opts = {}) {
  return prisma.$transaction(fn, { maxWait: 5000, timeout: 20000, ...opts });
}
