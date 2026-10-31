-- Database-level integrity guards that Prisma cannot express.

-- 1. Never oversell, even if application code has a bug.
ALTER TABLE "TicketType"
  ADD CONSTRAINT "TicketType_inventory_check"
  CHECK ("quantitySold" >= 0 AND "quantityReserved" >= 0 AND "quantitySold" + "quantityReserved" <= "quantityTotal");

-- 2. Money sanity.
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_price_check" CHECK ("price" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_check" CHECK ("total" >= 0 AND "commissionTotal" >= 0);

-- 3. Ledger is append-only: block UPDATE and DELETE.
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OrganizerLedgerEntry is append-only; post a reversing entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON "OrganizerLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

-- 4. Search helpers.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Event_title_trgm" ON "Event" USING gin ("title" gin_trgm_ops);
