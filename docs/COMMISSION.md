# Commission, refunds, ledger, payouts

## Rates
Default: `commissionPercent` (% of each ticket's price after discounts) plus an optional fixed fee per **paid** ticket. Set in `/admin#/settings` (defaults from `PLATFORM_COMMISSION_PERCENT` / `…_FIXED_PER_TICKET`). Free tickets carry no commission. An admin can override per event (if enabled).

**Pending-checkout pricing policy:** each order snapshots the unit price and the commission rate when it is created. Later price or commission changes affect only new orders.

## Calculation (`src/services/commission.js`, tested in `test/unit/commission.test.js`)
All money is integer minor units (kobo). Per order line: `commission = round_half_up(lineAmountAfterDiscount × percent) + fixed × tickets`, capped at the line amount. Discounts are allocated across lines proportionally before commission.

Example (5% + ₦0): 2 × ₦5,000 → gross ₦10,000, commission ₦500, organizer net ₦9,500.

## Refunds
Commission is reversed **pro rata** to the refunded amount (full refund → full reversal). A `CommissionRecord` exists once per order (unique). Refunded tickets are marked `REFUNDED` and fail check-in. Gateway fees are stored for reporting only; they are not deducted from the organizer unless you change the code.

## Ledger
`OrganizerLedgerEntry` is **append-only** (DB trigger blocks UPDATE/DELETE; see `prisma/guards.sql`) with a unique `idempotencyKey` so replays cannot double-post. Types: SALE (+), COMMISSION (−), REFUND (−), COMMISSION_REVERSAL (+), PAYOUT (−), ADJUSTMENT. Sale entries carry `availableAt = event end + settlementHoldDays`.

- **available** = total ledger − entries still inside the hold
- **pending** = entries inside the hold
These are accounting figures from this database, **not** a bank or Bachs balance.

## Payouts (manual, audited)
1. Organizer saves payout details (account number AES-GCM encrypted; last 4 shown) and requests an amount ≤ available (row-locked to prevent double spend). The request immediately posts a PAYOUT debit.
2. Admin approves → sends the bank transfer **outside the app** → records PAID with the bank reference.
3. Rejecting reverses the debit with an ADJUSTMENT entry.
