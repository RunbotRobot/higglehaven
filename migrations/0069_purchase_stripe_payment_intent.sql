-- #453: real-money checkout correlates each purchase with the Stripe
-- PaymentIntent that actually moved the money — needed so the refund
-- sub-issue (#348) has something to reverse, and so a client retrying the
-- confirm step after a network hiccup can't double-credit the builder by
-- replaying the same successful PaymentIntent (see the UNIQUE index below
-- and handleInstancePurchase's own lookup in worker/index.js). Stays NULL
-- for the pre-existing simulated-purchase path (Stripe not configured, or
-- a seller who hasn't finished Connect onboarding yet) — SQLite treats
-- multiple NULLs in a UNIQUE column as distinct, so those never collide
-- with each other or with a real payment intent id.
ALTER TABLE purchases ADD COLUMN stripe_payment_intent_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_stripe_payment_intent_id
ON purchases(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
