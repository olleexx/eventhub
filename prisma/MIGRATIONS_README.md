# Migrations

The initial table migration is NOT committed because it must be generated against a real database
(this scaffold was written without database access). Generate it once:

    npx prisma migrate dev --name init

Then add the SQL guards from `prisma/guards.sql` as a second migration:

    npx prisma migrate dev --create-only --name guards
    # paste the contents of prisma/guards.sql into the generated migration.sql, then
    npx prisma migrate dev

Deploy with `npm run db:migrate` (prisma migrate deploy).
