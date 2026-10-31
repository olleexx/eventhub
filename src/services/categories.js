import slugifyLib from 'slugify';
import { prisma } from '../lib/prisma.js';
import { conflict, notFound } from '../lib/errors.js';
import { audit } from './audit.js';

export const slugify = (s) => slugifyLib(s, { lower: true, strict: true, trim: true });

export const DEFAULT_CATEGORIES = ['Music & Concerts', 'Parties & Club Nights', 'Campus Events', 'Conferences', 'Workshops & Seminars', 'Festivals', 'Comedy', 'Religious Gatherings', 'Birthdays & Private Events', 'Sports & Fitness', 'Arts & Culture', 'Food & Drink'];

export const listCategories = ({ all = false } = {}) => prisma.eventCategory.findMany({ where: all ? {} : { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });

export async function ensureDefaultCategories() {
  for (const [i, name] of DEFAULT_CATEGORIES.entries()) {
    await prisma.eventCategory.upsert({ where: { slug: slugify(name) }, create: { name, slug: slugify(name), sortOrder: i }, update: {} });
  }
}

export async function saveCategory(admin, id, { name, active, sortOrder }, ip) {
  if (id) {
    const c = await prisma.eventCategory.findUnique({ where: { id } });
    if (!c) throw notFound('Category not found');
    const u = await prisma.eventCategory.update({ where: { id }, data: { ...(name ? { name } : {}), ...(active !== undefined ? { active } : {}), ...(sortOrder !== undefined ? { sortOrder } : {}) } });
    await audit({ actor: admin, action: 'category.update', entityType: 'EventCategory', entityId: id, before: { name: c.name, active: c.active }, after: { name: u.name, active: u.active }, ip });
    return u;
  }
  const slug = slugify(name);
  if (await prisma.eventCategory.findFirst({ where: { OR: [{ slug }, { name }] } })) throw conflict('Category already exists');
  const c = await prisma.eventCategory.create({ data: { name, slug, sortOrder: sortOrder ?? 100 } });
  await audit({ actor: admin, action: 'category.create', entityType: 'EventCategory', entityId: c.id, after: { name }, ip });
  return c;
}
