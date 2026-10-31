import { prisma, Prisma } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { uniqueSlug } from '../utils/slug.js';
import { sha256 } from '../utils/crypto.js';
import { toMinor, fromMinor } from '../lib/money.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';
import { recalcEventStats, releaseOrderInventory } from './inventory.js';
import { queueEmail, kickEmailQueue } from './email.js';
import { formatWhen } from './tickets.js';

const dec = (d) => (d == null ? null : d.toString());

// ---------------------------------------------------------------- public discovery

const PUBLIC_EVENT_FILTER = () => ({
  status: 'PUBLISHED',
  endsAt: { gte: new Date() },
  organizer: { suspended: false, user: { status: 'ACTIVE' } },
});

const cardSelect = {
  id: true, slug: true, title: true, shortDescription: true, bannerUrl: true, startsAt: true, endsAt: true, timezone: true,
  venueName: true, city: true, minPrice: true, ticketsRemaining: true, ticketsSold: true, featured: true, currency: true,
  category: { select: { name: true, slug: true } },
  organizer: { select: { brandName: true, logoUrl: true } },
};

export function toCard(e) {
  return {
    id: e.id, slug: e.slug, title: e.title, shortDescription: e.shortDescription, bannerUrl: e.bannerUrl,
    startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone, venueName: e.venueName, city: e.city,
    currency: e.currency, minPrice: dec(e.minPrice), isFree: e.minPrice != null && Number(e.minPrice) === 0,
    ticketsRemaining: e.ticketsRemaining, soldOut: e.ticketsRemaining <= 0, lowStock: e.ticketsRemaining > 0 && e.ticketsRemaining <= 20,
    featured: e.featured, category: e.category, organizer: e.organizer,
  };
}

const ORDERS = {
  date: [{ startsAt: 'asc' }],
  popular: [{ ticketsSold: 'desc' }, { startsAt: 'asc' }],
  new: [{ publishedAt: 'desc' }],
  price_asc: [{ minPrice: { sort: 'asc', nulls: 'last' } }, { startsAt: 'asc' }],
  price_desc: [{ minPrice: { sort: 'desc', nulls: 'last' } }, { startsAt: 'asc' }],
};

export async function listPublicEvents(q) {
  const and = [];
  if (q.q) {
    and.push({ OR: ['title', 'shortDescription', 'venueName', 'city'].map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' } })).concat([{ organizer: { brandName: { contains: q.q, mode: 'insensitive' } } }]) });
  }
  if (q.category) and.push({ category: { slug: q.category } });
  if (q.city) and.push({ city: { contains: q.city, mode: 'insensitive' } });
  if (q.organizer) and.push({ organizer: { brandName: { contains: q.organizer, mode: 'insensitive' } } });
  if (q.from) and.push({ startsAt: { gte: q.from } });
  if (q.to) and.push({ startsAt: { lte: q.to } });
  if (q.price === 'free') and.push({ minPrice: 0 });
  if (q.price === 'paid') and.push({ minPrice: { gt: 0 } });
  if (q.minPrice != null) and.push({ minPrice: { gte: q.minPrice } });
  if (q.maxPrice != null) and.push({ minPrice: { lte: q.maxPrice } });
  if (q.available) and.push({ ticketsRemaining: { gt: 0 } });
  const where = { ...PUBLIC_EVENT_FILTER(), ...(and.length ? { AND: and } : {}) };
  const [total, rows] = await Promise.all([
    prisma.event.count({ where }),
    prisma.event.findMany({ where, select: cardSelect, orderBy: ORDERS[q.sort], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  return { total, items: rows.map(toCard) };
}

export async function homeData({ city } = {}) {
  const base = PUBLIC_EVENT_FILTER();
  const take = 8;
  const find = (extra, orderBy, n = take) => prisma.event.findMany({ where: { ...base, ...extra }, select: cardSelect, orderBy, take: n });
  const [featured, trending, upcoming, fresh, limited, near, categories] = await Promise.all([
    find({ featured: true }, [{ startsAt: 'asc' }], 6),
    find({}, [{ ticketsSold: 'desc' }, { startsAt: 'asc' }]),
    find({}, [{ startsAt: 'asc' }]),
    find({}, [{ publishedAt: 'desc' }]),
    find({ ticketsRemaining: { gt: 0, lte: 20 } }, [{ ticketsRemaining: 'asc' }, { startsAt: 'asc' }]),
    city ? find({ city: { contains: city, mode: 'insensitive' } }, [{ startsAt: 'asc' }]) : Promise.resolve([]),
    prisma.eventCategory.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, slug: true, _count: { select: { events: { where: base } } } } }),
  ]);
  const cities = await prisma.event.groupBy({ by: ['city'], where: { ...base, city: { not: null } }, _count: true, orderBy: { _count: { city: 'desc' } }, take: 8 });
  return {
    featured: featured.map(toCard), trending: trending.map(toCard), upcoming: upcoming.map(toCard), newlyPublished: fresh.map(toCard), limited: limited.map(toCard), nearYou: near.map(toCard),
    categories: categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug, count: c._count.events })),
    cities: cities.map((c) => ({ city: c.city, count: c._count })),
  };
}

export function ticketAvailability(t, now = new Date()) {
  const remaining = Math.max(0, t.quantityTotal - t.quantitySold - t.quantityReserved);
  let state = 'ON_SALE';
  if (!t.active) state = 'UNAVAILABLE';
  else if (t.salesStartAt && t.salesStartAt > now) state = 'NOT_STARTED';
  else if (t.salesEndAt && t.salesEndAt < now) state = 'ENDED';
  else if (remaining === 0) state = 'SOLD_OUT';
  return { remaining, state };
}

/** Public event page payload. Unpublished events are visible only to people who can manage them (preview). */
export async function getPublicEvent(slug, user) {
  const event = await prisma.event.findUnique({
    where: { slug },
    include: {
      category: { select: { name: true, slug: true } },
      organizer: { select: { id: true, userId: true, brandName: true, logoUrl: true, bio: true, website: true, suspended: true, user: { select: { status: true } } } },
      images: { orderBy: { sortOrder: 'asc' }, select: { id: true, url: true, alt: true } },
      ticketTypes: { where: { visible: true, active: true }, orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] },
    },
  });
  if (!event) throw notFound('Event not found');
  const isOwner = Boolean(user?.organizer && user.organizer.id === event.organizerId);
  let canPreview = isOwner || user?.role === 'ADMIN';
  if (user && !canPreview) canPreview = Boolean(await prisma.eventStaff.findFirst({ where: { eventId: event.id, userId: user.id, role: 'MANAGER' } }));
  const publicVisible = ['PUBLISHED', 'CANCELLED'].includes(event.status) && !event.organizer.suspended && event.organizer.user.status === 'ACTIVE';
  if (!publicVisible && !canPreview) throw notFound('Event not found');

  prisma.event.update({ where: { id: event.id }, data: { viewCount: { increment: 1 } } }).catch(() => {});
  const favorited = user ? Boolean(await prisma.favoriteEvent.findUnique({ where: { userId_eventId: { userId: user.id, eventId: event.id } } })) : false;
  const now = new Date();
  const settings = await getSettings();
  return {
    id: event.id, slug: event.slug, title: event.title, status: event.status, preview: !publicVisible,
    shortDescription: event.shortDescription, description: event.description,
    startsAt: event.startsAt, endsAt: event.endsAt, timezone: event.timezone,
    venueName: event.venueName, city: event.city, address: event.address, onlineUrl: event.onlineUrl, mapUrl: event.mapUrl, venueInstructions: event.venueInstructions,
    bannerUrl: event.bannerUrl, images: event.images, entryInstructions: event.entryInstructions, refundPolicy: event.refundPolicy, terms: event.terms,
    ageRestriction: event.ageRestriction, refundDeadline: event.refundDeadline, customQuestions: event.customQuestions, currency: event.currency, ticketDesign: event.ticketDesign,
    category: event.category, organizer: { brandName: event.organizer.brandName, logoUrl: event.organizer.logoUrl, bio: event.organizer.bio, website: event.organizer.website },
    favorited, ended: Boolean(event.endsAt && event.endsAt < now), maxTicketsPerOrder: settings.maxTicketsPerOrder, waitlistEnabled: settings.featureWaitlist, discountsEnabled: settings.featureDiscountCodes,
    ticketTypes: event.ticketTypes.map((t) => ({
      id: t.id, name: t.name, description: t.description, price: dec(t.price),
      minPerOrder: t.minPerOrder, maxPerOrder: Math.min(t.maxPerOrder, settings.maxTicketsPerOrder),
      salesStartAt: t.salesStartAt, salesEndAt: t.salesEndAt, ...ticketAvailability(t, now),
    })),
  };
}

// ---------------------------------------------------------------- organizer: events

async function ensureCategory(categoryId) {
  if (!categoryId) return;
  const c = await prisma.eventCategory.findFirst({ where: { id: categoryId, active: true } });
  if (!c) throw badRequest('Unknown category', [{ path: 'categoryId', message: 'Choose a valid category' }]);
}

function validateDates(startsAt, endsAt) {
  if (startsAt && endsAt && endsAt <= startsAt) throw badRequest('The event must end after it starts', [{ path: 'endsAt', message: 'End must be after start' }]);
}

const trackedFields = ['title', 'startsAt', 'endsAt', 'venueName', 'city', 'address', 'onlineUrl', 'status'];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] instanceof Date ? obj[k].toISOString() : obj[k] ?? null]));

export async function createEvent(user, data, ip) {
  await ensureCategory(data.categoryId);
  validateDates(data.startsAt, data.endsAt);
  const title = data.title || 'Untitled event';
  const slug = await uniqueSlug(title, async (s) => Boolean(await prisma.event.findUnique({ where: { slug: s }, select: { id: true } })));
  const { customQuestions, ticketDesign, ...rest } = data;
  const event = await prisma.event.create({
    data: { ...rest, title, slug, organizerId: user.organizer.id, ...(customQuestions && { customQuestions }), ...(ticketDesign && { ticketDesign }) },
  });
  await audit({ actor: user, action: 'event.create', entityType: 'Event', entityId: event.id, eventId: event.id, ip });
  return event;
}

export async function updateEvent(user, access, data, ip) {
  const { event } = access;
  if (['CANCELLED', 'SUSPENDED'].includes(event.status)) throw conflict(`A ${event.status.toLowerCase()} event cannot be edited`, 'EVENT_LOCKED');
  if (data.categoryId !== undefined) await ensureCategory(data.categoryId);
  const startsAt = data.startsAt ?? event.startsAt;
  const endsAt = data.endsAt ?? event.endsAt;
  validateDates(startsAt, endsAt);
  const { customQuestions, ticketDesign, ...rest } = data;
  const updated = await prisma.event.update({ where: { id: event.id }, data: { ...rest, ...(customQuestions && { customQuestions }), ...(ticketDesign && { ticketDesign }) } });
  const before = pick(event, trackedFields);
  const after = pick(updated, trackedFields);
  await audit({ actor: user, action: 'event.update', entityType: 'Event', entityId: event.id, eventId: event.id, before, after, ip });

  const material = ['startsAt', 'endsAt', 'venueName', 'address', 'city', 'onlineUrl'].some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (material && event.status === 'PUBLISHED') {
    await notifyAttendees(updated, `The event details changed. When: ${formatWhen(updated.startsAt, updated.timezone)}. Where: ${[updated.venueName, updated.city].filter(Boolean).join(', ') || 'online'}.`);
  }
  return updated;
}

export async function publishChecklist(event, user) {
  const settings = await getSettings();
  const types = await prisma.ticketType.findMany({ where: { eventId: event.id, active: true, visible: true } });
  const earliest = new Date(Date.now() + settings.minPublishLeadMinutes * 60_000);
  const checks = [
    { key: 'title', label: 'Event title', ok: Boolean(event.title && event.title !== 'Untitled event' && event.title.length >= 3) },
    { key: 'category', label: 'Category selected', ok: Boolean(event.categoryId) },
    { key: 'short', label: 'Short description (10+ characters)', ok: (event.shortDescription || '').length >= 10 },
    { key: 'description', label: 'Full description (30+ characters)', ok: (event.description || '').length >= 30 },
    { key: 'banner', label: 'Event banner uploaded', ok: Boolean(event.bannerUrl) },
    { key: 'dates', label: 'Start and end date set, end after start, still in the future', ok: Boolean(event.startsAt && event.endsAt && event.endsAt > event.startsAt && event.endsAt > earliest) },
    { key: 'venue', label: 'Venue and city (or an online URL)', ok: Boolean((event.venueName && event.city) || event.onlineUrl) },
    { key: 'tickets', label: 'At least one visible ticket type with quantity', ok: types.some((t) => t.quantityTotal > 0) },
    { key: 'refund', label: 'Refund policy written', ok: Boolean(event.refundPolicy) },
    { key: 'terms', label: 'Terms & entry rules written', ok: Boolean(event.terms) },
  ];
  if (settings.requireVerifiedEmailToPublish) checks.push({ key: 'email', label: 'Your email address is verified', ok: Boolean(user.emailVerifiedAt) });
  return { ok: checks.every((c) => c.ok), checks };
}

export async function publishEvent(user, access, ip) {
  const { event } = access;
  if (['CANCELLED', 'SUSPENDED'].includes(event.status)) throw conflict(`This event is ${event.status.toLowerCase()} and cannot be published`, 'EVENT_LOCKED');
  if (user.organizer?.suspended) throw forbidden('Your organizer account is suspended');
  const check = await publishChecklist(event, user);
  if (!check.ok) throw unprocessable('Complete the checklist before publishing', check.checks.filter((c) => !c.ok), 'PUBLISH_CHECKLIST');
  const scheduled = event.scheduledPublishAt && event.scheduledPublishAt > new Date();
  const status = scheduled ? 'SCHEDULED' : 'PUBLISHED';
  const updated = await prisma.event.update({ where: { id: event.id }, data: { status, publishedAt: scheduled ? null : event.publishedAt ?? new Date(), moderationNote: null } });
  await prisma.$transaction((tx) => recalcEventStats(tx, event.id));
  await audit({ actor: user, action: scheduled ? 'event.schedule' : 'event.publish', entityType: 'Event', entityId: event.id, eventId: event.id, before: { status: event.status }, after: { status }, ip });
  return updated;
}

export async function unpublishEvent(user, access, ip) {
  const { event } = access;
  if (!['PUBLISHED', 'SCHEDULED'].includes(event.status)) throw conflict('Only published or scheduled events can be unpublished');
  const updated = await prisma.event.update({ where: { id: event.id }, data: { status: 'UNPUBLISHED' } });
  await audit({ actor: user, action: 'event.unpublish', entityType: 'Event', entityId: event.id, eventId: event.id, before: { status: event.status }, after: { status: 'UNPUBLISHED' }, ip });
  return updated;
}

/** Called by the scheduler: publish events whose scheduled time has arrived. Idempotent. */
export async function publishDueEvents() {
  const due = await prisma.event.findMany({ where: { status: 'SCHEDULED', scheduledPublishAt: { lte: new Date() } }, select: { id: true } });
  let n = 0;
  for (const { id } of due) {
    const r = await prisma.event.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
    if (r.count) { n++; await prisma.$transaction((tx) => recalcEventStats(tx, id)); }
  }
  return n;
}

export async function duplicateEvent(user, access, ip) {
  const { event } = access;
  const types = await prisma.ticketType.findMany({ where: { eventId: event.id, active: true } });
  const title = `${event.title} (copy)`.slice(0, 120);
  const slug = await uniqueSlug(title, async (s) => Boolean(await prisma.event.findUnique({ where: { slug: s }, select: { id: true } })));
  const copy = await prisma.$transaction(async (tx) => {
    const c = await tx.event.create({
      data: {
        organizerId: event.organizerId, categoryId: event.categoryId, title, slug, shortDescription: event.shortDescription, description: event.description,
        timezone: event.timezone, venueName: event.venueName, city: event.city, address: event.address, onlineUrl: event.onlineUrl, mapUrl: event.mapUrl,
        venueInstructions: event.venueInstructions, bannerUrl: event.bannerUrl, entryInstructions: event.entryInstructions, refundPolicy: event.refundPolicy,
        terms: event.terms, ageRestriction: event.ageRestriction, ticketDesign: event.ticketDesign ?? {}, customQuestions: event.customQuestions ?? [], currency: event.currency,
      },
    });
    for (const t of types) {
      await tx.ticketType.create({ data: { eventId: c.id, name: t.name, description: t.description, price: t.price, quantityTotal: t.quantityTotal, minPerOrder: t.minPerOrder, maxPerOrder: t.maxPerOrder, perCustomerLimit: t.perCustomerLimit, visible: t.visible, sortOrder: t.sortOrder } });
    }
    await recalcEventStats(tx, c.id);
    await audit({ actor: user, action: 'event.duplicate', entityType: 'Event', entityId: c.id, eventId: c.id, before: { from: event.id }, ip }, tx);
    return c;
  });
  return copy;
}

/** Notify every distinct paying customer of an event (deduplicated per message). */
export async function notifyAttendees(event, message) {
  const orders = await prisma.order.findMany({ where: { eventId: event.id, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } }, select: { buyerEmail: true } });
  const emails = [...new Set(orders.map((o) => o.buyerEmail))];
  const key = sha256(message).slice(0, 16);
  for (const to of emails) {
    await queueEmail(prisma, { to, template: 'event_update', data: { eventTitle: event.title, eventSlug: event.slug, message }, dedupeKey: `event-update:${event.id}:${key}:${to}` });
  }
  if (emails.length) kickEmailQueue();
  return emails.length;
}

/**
 * Cancel an event. Organizers may cancel before it starts; later cancellations need an admin.
 * All paid orders get an approved full-refund request (processed through the gateway by the refund
 * worker) and tickets stop admitting immediately. Pending checkouts are released.
 */
export async function cancelEvent(user, event, reason, ip) {
  if (event.status === 'CANCELLED') throw conflict('Event is already cancelled');
  const isAdmin = user.role === 'ADMIN';
  if (!isAdmin && event.startsAt && event.startsAt < new Date()) throw forbidden('This event has already started. Contact support to cancel it.', 'CANCEL_AFTER_START');

  const result = await prisma.$transaction(async (tx) => {
    await tx.event.update({ where: { id: event.id }, data: { status: 'CANCELLED', moderationNote: isAdmin ? reason : null } });
    await tx.ticket.updateMany({ where: { eventId: event.id, status: 'VALID' }, data: { status: 'CANCELLED' } });

    const pending = await tx.order.findMany({ where: { eventId: event.id, status: 'PENDING' }, select: { id: true } });
    for (const o of pending) {
      await tx.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } });
      await releaseOrderInventory(tx, o.id);
    }

    const paid = await tx.order.findMany({ where: { eventId: event.id, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } }, include: { refunds: true } });
    let refunds = 0;
    for (const o of paid) {
      const remaining = toMinor(o.total) - toMinor(o.refundedTotal);
      const inFlight = o.refunds.some((r) => ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(r.status));
      if (remaining > 0 && !inFlight) {
        await tx.refund.create({
          data: { orderId: o.id, amount: fromMinor(remaining), reason: `Event cancelled: ${reason}`, status: 'APPROVED', isEventCancellation: true, idempotencyKey: `cancel:${o.id}`, reviewNote: 'Automatic: event cancelled' },
        });
        refunds++;
      }
      await queueEmail(tx, { to: o.buyerEmail, template: 'event_cancelled', data: { eventTitle: event.title, reference: o.reference, reason, paid: remaining > 0 }, dedupeKey: `event-cancel:${o.id}` });
    }
    await recalcEventStats(tx, event.id);
    await audit({ actor: user, action: 'event.cancel', entityType: 'Event', entityId: event.id, eventId: event.id, before: { status: event.status }, after: { status: 'CANCELLED', reason, refundsCreated: refunds }, ip }, tx);
    return { refunds, released: pending.length };
  });
  kickEmailQueue();
  return result;
}

// ---------------------------------------------------------------- organizer: ticket types

export async function createTicketType(user, access, data, ip) {
  const { event } = access;
  if (['CANCELLED', 'SUSPENDED'].includes(event.status)) throw conflict('This event cannot be changed', 'EVENT_LOCKED');
  const settings = await getSettings();
  if (data.quantityTotal > settings.maxTicketsPerEventTypeIncrease) throw badRequest(`Quantity cannot exceed ${settings.maxTicketsPerEventTypeIncrease}`);
  const t = await prisma.$transaction(async (tx) => {
    const created = await tx.ticketType.create({ data: { ...data, eventId: event.id } });
    await recalcEventStats(tx, event.id);
    await audit({ actor: user, action: 'ticket_type.create', entityType: 'TicketType', entityId: created.id, eventId: event.id, after: { name: created.name, price: dec(created.price), quantityTotal: created.quantityTotal }, ip }, tx);
    return created;
  });
  return t;
}

/**
 * Update a ticket type. Safe by construction:
 *  - price changes only affect FUTURE orders (orders snapshot unitPrice at creation)
 *  - quantityTotal can never drop below sold + reserved (conditional UPDATE, race-safe)
 *  - increases are capped by a platform setting
 *  - every price/quantity change is audited with before/after values and the actor
 */
export async function updateTicketType(user, access, ticketTypeId, data, ip) {
  const { event } = access;
  if (['CANCELLED', 'SUSPENDED'].includes(event.status)) throw conflict('This event cannot be changed', 'EVENT_LOCKED');
  const settings = await getSettings();
  const current = await prisma.ticketType.findFirst({ where: { id: ticketTypeId, eventId: event.id } });
  if (!current) throw notFound('Ticket type not found');
  if (data.quantityTotal != null && data.quantityTotal > settings.maxTicketsPerEventTypeIncrease) throw badRequest(`Quantity cannot exceed ${settings.maxTicketsPerEventTypeIncrease}`);

  const minPer = data.minPerOrder ?? current.minPerOrder;
  const maxPer = data.maxPerOrder ?? current.maxPerOrder;
  if (minPer > maxPer) throw badRequest('Minimum per order cannot exceed maximum', [{ path: 'minPerOrder', message: 'Too high' }]);
  const start = data.salesStartAt === undefined ? current.salesStartAt : data.salesStartAt;
  const end = data.salesEndAt === undefined ? current.salesEndAt : data.salesEndAt;
  if (start && end && start >= end) throw badRequest('Sales must close after they open', [{ path: 'salesEndAt', message: 'Must be after the start' }]);

  const { quantityTotal, ...rest } = data;
  const updated = await prisma.$transaction(async (tx) => {
    if (quantityTotal != null) {
      const n = await tx.$executeRaw(Prisma.sql`UPDATE "TicketType" SET "quantityTotal" = ${quantityTotal} WHERE "id" = ${ticketTypeId} AND "quantitySold" + "quantityReserved" <= ${quantityTotal}`);
      if (n === 0) throw conflict('Quantity cannot be lower than tickets already sold or being purchased', 'QUANTITY_BELOW_SOLD');
    }
    const row = await tx.ticketType.update({ where: { id: ticketTypeId }, data: rest });
    await recalcEventStats(tx, event.id);
    const before = { price: dec(current.price), quantityTotal: current.quantityTotal, visible: current.visible, name: current.name, salesStartAt: current.salesStartAt, salesEndAt: current.salesEndAt };
    const after = { price: dec(row.price), quantityTotal: row.quantityTotal, visible: row.visible, name: row.name, salesStartAt: row.salesStartAt, salesEndAt: row.salesEndAt };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const action = before.price !== after.price ? 'ticket_type.price_change' : before.quantityTotal !== after.quantityTotal ? 'ticket_type.inventory_change' : 'ticket_type.update';
      await audit({ actor: user, action, entityType: 'TicketType', entityId: ticketTypeId, eventId: event.id, before, after, ip }, tx);
    }
    return row;
  });
  return updated;
}

/** Ticket types with sales history are archived (active=false), never deleted. */
export async function removeTicketType(user, access, ticketTypeId, ip) {
  const { event } = access;
  const t = await prisma.ticketType.findFirst({ where: { id: ticketTypeId, eventId: event.id } });
  if (!t) throw notFound('Ticket type not found');
  if (t.quantityReserved > 0) throw conflict('Customers are checking out with this ticket right now. Try again in a few minutes.', 'IN_USE');
  const used = await prisma.orderItem.count({ where: { ticketTypeId } });
  await prisma.$transaction(async (tx) => {
    if (used === 0) await tx.ticketType.delete({ where: { id: ticketTypeId } });
    else await tx.ticketType.update({ where: { id: ticketTypeId }, data: { active: false, visible: false } });
    await recalcEventStats(tx, event.id);
    await audit({ actor: user, action: used === 0 ? 'ticket_type.delete' : 'ticket_type.archive', entityType: 'TicketType', entityId: ticketTypeId, eventId: event.id, before: { name: t.name, price: dec(t.price) }, ip }, tx);
  });
  return { archived: used > 0 };
}

export async function organizerEventList(user, { status, q, page, pageSize }) {
  const where = {
    OR: [{ organizerId: user.organizer?.id ?? '__none__' }, { staff: { some: { userId: user.id } } }],
    ...(status ? { status } : {}),
    ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.event.count({ where }),
    prisma.event.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      select: { id: true, slug: true, title: true, status: true, startsAt: true, endsAt: true, bannerUrl: true, city: true, ticketsSold: true, ticketsRemaining: true, minPrice: true, organizerId: true, updatedAt: true, staff: { where: { userId: user.id }, select: { role: true } } },
    }),
  ]);
  return {
    total,
    items: rows.map((e) => ({ ...e, minPrice: dec(e.minPrice), myRole: e.organizerId === user.organizer?.id ? 'OWNER' : e.staff[0]?.role ?? null, staff: undefined })),
  };
}

export async function getEventForEdit(access) {
  const { event } = access;
  const [ticketTypes, images, discounts, checklist] = await Promise.all([
    prisma.ticketType.findMany({ where: { eventId: event.id, active: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.eventImage.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: 'asc' } }),
    access.can.finance ? prisma.discountCode.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'desc' } }) : [],
    null,
  ]);
  return {
    event: { ...event, minPrice: dec(event.minPrice), commissionOverridePercent: undefined, commissionOverrideFixed: undefined },
    ticketTypes: ticketTypes.map((t) => ({ ...t, price: dec(t.price), remaining: Math.max(0, t.quantityTotal - t.quantitySold - t.quantityReserved) })),
    images, discounts: discounts.map((d) => ({ ...d, percentOff: dec(d.percentOff), amountOff: dec(d.amountOff) })),
    permissions: access.can,
  };
}

export async function addEventImage(access, url, alt) {
  const count = await prisma.eventImage.count({ where: { eventId: access.event.id } });
  if (count >= 8) throw badRequest('You can add up to 8 promotional images');
  return prisma.eventImage.create({ data: { eventId: access.event.id, url, alt: alt || null, sortOrder: count } });
}

export async function removeEventImage(access, imageId) {
  const img = await prisma.eventImage.findFirst({ where: { id: imageId, eventId: access.event.id } });
  if (!img) throw notFound('Image not found');
  await prisma.eventImage.delete({ where: { id: imageId } });
}

export async function setBanner(access, url) {
  return prisma.event.update({ where: { id: access.event.id }, data: { bannerUrl: url } });
}

// ---------------------------------------------------------------- favourites, reports, discounts, waitlist

export async function toggleFavorite(user, eventId, on) {
  const event = await prisma.event.findFirst({ where: { id: eventId, status: 'PUBLISHED' }, select: { id: true } });
  if (!event) throw notFound('Event not found');
  if (on) await prisma.favoriteEvent.upsert({ where: { userId_eventId: { userId: user.id, eventId } }, create: { userId: user.id, eventId }, update: {} });
  else await prisma.favoriteEvent.deleteMany({ where: { userId: user.id, eventId } });
  return { favorited: on };
}

export async function listFavorites(user) {
  const rows = await prisma.favoriteEvent.findMany({ where: { userId: user.id, event: PUBLIC_EVENT_FILTER() }, include: { event: { select: cardSelect } }, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map((r) => toCard(r.event));
}

export async function reportEvent(user, eventId, { reason, details }) {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) throw notFound('Event not found');
  const recent = user ? await prisma.eventReport.count({ where: { eventId, reporterId: user.id, createdAt: { gt: new Date(Date.now() - 86400_000) } } }) : 0;
  if (recent > 0) throw conflict('You already reported this event today');
  return prisma.eventReport.create({ data: { eventId, reporterId: user?.id ?? null, reason, details } });
}

export async function createDiscount(user, access, data, ip) {
  const settings = await getSettings();
  if (!settings.featureDiscountCodes) throw forbidden('Discount codes are disabled');
  const exists = await prisma.discountCode.findUnique({ where: { eventId_code: { eventId: access.event.id, code: data.code } } });
  if (exists) throw conflict('That code already exists for this event', 'DUPLICATE');
  const d = await prisma.discountCode.create({ data: { eventId: access.event.id, code: data.code, percentOff: data.percentOff ?? null, amountOff: data.amountOff && Number(data.amountOff) > 0 ? data.amountOff : null, maxUses: data.maxUses ?? null, expiresAt: data.expiresAt ?? null, active: data.active } });
  await audit({ actor: user, action: 'discount.create', entityType: 'DiscountCode', entityId: d.id, eventId: access.event.id, after: { code: d.code }, ip });
  return d;
}

export async function setDiscountActive(user, access, discountId, active) {
  const d = await prisma.discountCode.findFirst({ where: { id: discountId, eventId: access.event.id } });
  if (!d) throw notFound('Discount not found');
  return prisma.discountCode.update({ where: { id: discountId }, data: { active } });
}

export async function joinWaitlist({ eventId, email, ticketTypeId }) {
  const settings = await getSettings();
  if (!settings.featureWaitlist) throw forbidden('Waitlist is disabled');
  const event = await prisma.event.findFirst({ where: { id: eventId, status: 'PUBLISHED' }, select: { id: true, ticketsRemaining: true } });
  if (!event) throw notFound('Event not found');
  await prisma.waitlistEntry.createMany({ data: [{ eventId, email, ticketTypeId: ticketTypeId ?? null }], skipDuplicates: true });
}

/** Notify waitlisted people when capacity returns. Called by the scheduler; idempotent via notifiedAt. */
export async function notifyWaitlists() {
  const events = await prisma.event.findMany({ where: { status: 'PUBLISHED', ticketsRemaining: { gt: 0 }, waitlist: { some: { notifiedAt: null } } }, select: { id: true, title: true, slug: true, ticketsRemaining: true }, take: 50 });
  let n = 0;
  for (const e of events) {
    const entries = await prisma.waitlistEntry.findMany({ where: { eventId: e.id, notifiedAt: null }, orderBy: { createdAt: 'asc' }, take: Math.max(1, e.ticketsRemaining * 3) });
    for (const w of entries) {
      const claimed = await prisma.waitlistEntry.updateMany({ where: { id: w.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
      if (claimed.count) { await queueEmail(prisma, { to: w.email, template: 'waitlist_available', data: { eventTitle: e.title, eventSlug: e.slug }, dedupeKey: `waitlist:${w.id}` }); n++; }
    }
  }
  if (n) kickEmailQueue();
  return n;
}
