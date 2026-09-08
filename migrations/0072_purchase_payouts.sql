-- #454 (sub-issue of #347/#324): a real-money sale's proceeds
-- (total_cents - commission_cents) already land in the seller's own
-- Stripe Custom-account balance the moment it's charged, via #453's own
-- transfer_data -- what's new here is a policy-driven hold before
-- higglehaven lets the seller actually request payout of it, per the
-- owner-confirmed policy (Control Room msg-q-issue-454-trust-tiers):
-- digital goods pay out instantly (no hold at all -- there's no shipping,
-- no chargeback window where non-delivery is plausible), physical goods
-- hold until whichever comes first: the buyer confirms delivery, or 7
-- days after the seller marks it shipped. Only meaningful for a
-- real-money purchase (payment_intent_id NOT NULL, #453) -- a simulated
-- (higgles) purchase never has a Stripe balance to hold against, so these
-- all stay at their defaults for it forever.
ALTER TABLE purchases ADD COLUMN is_digital_good INTEGER NOT NULL DEFAULT 0;
-- Seller-set once they've shipped a physical order — the start of the
-- 7-day fallback clock. NULL for a digital good (no shipping) and for
-- anything not yet shipped.
ALTER TABLE purchases ADD COLUMN shipped_at TEXT;
-- Set by hitting the public, unauthenticated confirm-delivery link this
-- issue's own scope calls for (docs/API.md's "Purchase delivery
-- confirmation") — there is no real buyer account anywhere in this app
-- (see "Simulated purchases") to authenticate a "my orders" view against,
-- so delivery_confirm_token (below) is the only thing standing in for
-- buyer identity here: whoever holds the link can confirm it, the same
-- trust model a real guest-checkout order-tracking link already relies on.
ALTER TABLE purchases ADD COLUMN delivery_confirmed_at TEXT;
-- Generated once, at purchase-finalize time, for every real-money
-- physical purchase (regardless of whether it's shipped yet) — so a
-- seller can hand the link to their buyer through whatever channel they
-- actually used to arrange the sale (this app collects no buyer contact
-- info to email it automatically). Only the SHA-256 hash is ever stored,
-- same discipline as password_reset_tokens (migrations/0053) — a DB leak
-- alone should never be enough to confirm someone else's delivery early
-- and unlock their hold; the raw token only ever exists in the API
-- response handed to the seller and whatever link they forward.
ALTER TABLE purchases ADD COLUMN delivery_confirm_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_delivery_confirm_token_hash
  ON purchases(delivery_confirm_token_hash) WHERE delivery_confirm_token_hash IS NOT NULL;
-- Set once this purchase's own seller-share has actually been included in
-- a triggered Stripe payout (worker/index.js's handleSellerPayout) — a
-- purchase past its hold but with paid_out_at still NULL is "available";
-- past its hold with this set is "already cashed out."
ALTER TABLE purchases ADD COLUMN paid_out_at TEXT;
ALTER TABLE purchases ADD COLUMN stripe_payout_id TEXT;
CREATE INDEX IF NOT EXISTS idx_purchases_seller_payout ON purchases(seller_id, paid_out_at);
