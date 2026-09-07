-- #453 (sub-issue of #347/#324): real-money checkout via Stripe adds a
-- second purchase path alongside the existing dev-mode simulation (see
-- migrations/0051's own header) — one where a Stripe PaymentIntent must
-- actually succeed before the purchases row is written (worker/index.js's
-- new handlePurchaseFinalize). This column records which PaymentIntent
-- backed a real-money purchase, so the refund sub-issue (#348) has
-- something to reverse; NULL for every simulated (no seller Stripe
-- account) purchase, exactly as before.
--
-- UNIQUE (not just indexed) so a PaymentIntent can never back more than
-- one purchases row — the finalize handler already checks for an existing
-- row with this id before writing (an ordinary "already finalized, return
-- what's there" idempotency check), but the constraint closes the same
-- gap a concurrent double-call could otherwise slip through, the same
-- belt-and-suspenders reasoning this codebase already applies elsewhere
-- (e.g. #415's owner-guard writes).
ALTER TABLE purchases ADD COLUMN payment_intent_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_payment_intent_id ON purchases(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
