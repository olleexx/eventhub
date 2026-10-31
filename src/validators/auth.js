import { z } from 'zod';
import { email, password, trimmed, phone } from './common.js';

export const registerBody = z.object({
  email,
  password,
  name: trimmed(100, 2),
  phone: phone.optional().or(z.literal('')),
  asOrganizer: z.boolean().default(false),
  brandName: z.string().trim().max(100).optional(),
  marketingConsent: z.boolean().default(false),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms and Privacy Policy' }) }),
}).strict();

export const loginBody = z.object({ email, password: z.string().min(1).max(200) }).strict();
export const tokenBody = z.object({ token: z.string().min(20).max(200) }).strict();
export const forgotBody = z.object({ email }).strict();
export const resetBody = z.object({ token: z.string().min(20).max(200), password }).strict();
export const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }).strict();
export const profileBody = z.object({
  name: trimmed(100, 2).optional(),
  phone: phone.optional().or(z.literal('')),
  marketingConsent: z.boolean().optional(),
  notifyPrefs: z.object({ eventUpdates: z.boolean().optional(), marketing: z.boolean().optional(), reminders: z.boolean().optional() }).strict().optional(),
}).strict();
export const becomeOrganizerBody = z.object({ brandName: trimmed(100, 2) }).strict();
