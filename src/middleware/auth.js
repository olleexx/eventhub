import { unauthorized, forbidden } from '../lib/errors.js';

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Organizer routes: user must have an active OrganizerProfile (ADMINs are not implicitly organizers). */
export function requireOrganizer(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.organizer) return next(forbidden('Organizer account required', 'NOT_ORGANIZER'));
  if (req.user.organizer.suspended) return next(forbidden('Organizer account is suspended', 'ORGANIZER_SUSPENDED'));
  next();
}

export function requireVerifiedEmail(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.emailVerifiedAt) return next(forbidden('Please verify your email address first', 'EMAIL_NOT_VERIFIED'));
  next();
}
