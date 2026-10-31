import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { audit } from './audit.js';
import { AppError } from '../lib/errors.js';

const money = z.coerce.number().min(0).max(1_000_000);

export const settingsSchema = z.object({
  platformName: z.string().trim().min(1).max(60),
  supportEmail: z.string().trim().email().max(200),
  supportPhone: z.string().trim().max(40),
  commissionPercent: z.coerce.number().min(0).max(100),
  commissionFixedPerTicket: money,
  allowEventCommissionOverride: z.boolean(),
  defaultCurrency: z.enum(['NGN']),
  reservationMinutes: z.coerce.number().int().min(5).max(60),
  settlementHoldDays: z.coerce.number().int().min(0).max(60),
  maxTicketsPerOrder: z.coerce.number().int().min(1).max(100),
  maxTicketsPerEventTypeIncrease: z.coerce.number().int().min(1).max(1_000_000),
  guestCheckout: z.boolean(),
  maintenanceMode: z.boolean(),
  requireVerifiedEmailToPublish: z.boolean(),
  minPublishLeadMinutes: z.coerce.number().int().min(0).max(10_080),
  featureWaitlist: z.boolean(),
  featureDiscountCodes: z.boolean(),
  eventCategories: z.undefined().optional(),
});

export const DEFAULTS = Object.freeze({
  platformName: config.PLATFORM_NAME,
  supportEmail: 'support@example.com',
  supportPhone: '',
  commissionPercent: config.PLATFORM_COMMISSION_PERCENT,
  commissionFixedPerTicket: config.PLATFORM_COMMISSION_FIXED_PER_TICKET,
  allowEventCommissionOverride: true,
  defaultCurrency: 'NGN',
  reservationMinutes: 15,
  settlementHoldDays: 3,
  maxTicketsPerOrder: 10,
  maxTicketsPerEventTypeIncrease: 100_000,
  guestCheckout: true,
  maintenanceMode: false,
  requireVerifiedEmailToPublish: true,
  minPublishLeadMinutes: 0,
  featureWaitlist: true,
  featureDiscountCodes: true,
});

let cache = { at: 0, value: null };
const TTL_MS = 10_000;

export function invalidateSettingsCache() {
  cache = { at: 0, value: null };
}

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await prisma.platformSetting.findMany();
  const merged = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS) merged[r.key] = r.value;
  cache = { at: Date.now(), value: Object.freeze(merged) };
  return cache.value;
}

/** Public subset safe to expose to the browser. */
export function publicSettings(s) {
  return {
    platformName: s.platformName,
    supportEmail: s.supportEmail,
    supportPhone: s.supportPhone,
    currency: s.defaultCurrency,
    guestCheckout: s.guestCheckout,
    maintenanceMode: s.maintenanceMode,
    featureWaitlist: s.featureWaitlist,
    featureDiscountCodes: s.featureDiscountCodes,
    maxTicketsPerOrder: s.maxTicketsPerOrder,
  };
}

export async function updateSettings(patch, actor, ip) {
  const parsed = settingsSchema.partial().strict().safeParse(patch);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid settings', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const partial = parsed.data;
  const before = await getSettings({ fresh: true });
  const changed = {};
  await prisma.$transaction(async (tx) => {
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined || !(key in DEFAULTS)) continue;
      if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
      changed[key] = { from: before[key], to: value };
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value, updatedBy: actor.id },
        update: { value, updatedBy: actor.id },
      });
    }
    if (Object.keys(changed).length) {
      await audit({ actor, action: 'settings.update', entityType: 'PlatformSetting', before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])), after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])), ip }, tx);
    }
  });
  invalidateSettingsCache();
  return getSettings({ fresh: true });
}
