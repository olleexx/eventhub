// Idempotent initial-admin provisioning. Reads ADMIN_EMAIL / ADMIN_PASSWORD from the environment
// (or argv: node scripts/create-admin.js you@example.com 'a long passphrase'). Never exposed over HTTP.
import 'node:process';
import { provisionAdmin } from '../src/services/auth.js';
import { prisma } from '../src/lib/prisma.js';

const email = process.argv[2] || process.env.ADMIN_EMAIL;
const password = process.argv[3] || process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ chars), or pass them as arguments.');
  process.exit(1);
}
try {
  const u = await provisionAdmin(email, password);
  console.log(`Admin ready: ${u.email} (id ${u.id}). Remove ADMIN_PASSWORD from the environment now.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
