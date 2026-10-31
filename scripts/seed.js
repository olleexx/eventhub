// Seeds reference data only (event categories). Pass --demo to also create a demo organizer with one
// DRAFT event and no sales (no fake orders, revenue or statistics are ever inserted).
import { prisma } from '../src/lib/prisma.js';
import { ensureDefaultCategories } from '../src/services/categories.js';
import { hashPassword } from '../src/services/auth.js';

await ensureDefaultCategories();
console.log('Categories ready.');

if (process.argv.includes('--demo')) {
  const email = 'demo-organizer@example.com';
  const exists = await prisma.user.findUnique({ where: { email } });
  if (!exists) {
    const u = await prisma.user.create({ data: { email, name: 'Demo Organizer', passwordHash: await hashPassword('demo-password-123'), role: 'ORGANIZER', emailVerifiedAt: new Date(), organizer: { create: { brandName: 'Demo Events' } } }, include: { organizer: true } });
    const cat = await prisma.eventCategory.findFirst();
    const starts = new Date(Date.now() + 30 * 86_400_000);
    await prisma.event.create({ data: { organizerId: u.organizer.id, categoryId: cat?.id, title: 'Demo Rooftop Party', slug: 'demo-rooftop-party', status: 'DRAFT', startsAt: starts, endsAt: new Date(starts.getTime() + 6 * 3600_000), venueName: 'The Roof', city: 'Lagos', shortDescription: 'A demo draft event created by the seed script.', ticketTypes: { create: [{ name: 'Regular', price: '5000.00', quantityTotal: 100 }, { name: 'VIP', price: '15000.00', quantityTotal: 20 }] } } });
    console.log(`Demo organizer created: ${email} / demo-password-123 (development only; delete in production).`);
  }
}
await prisma.$disconnect();
