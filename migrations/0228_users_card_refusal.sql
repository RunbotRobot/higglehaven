-- #3565: when Stripe itself refuses a card during sign-up (before our own
-- confirm-card ever runs), nothing was recorded, so support could not tell
-- "declined" from "never tried". The browser reports the refusal (fail-open,
-- best effort) and these four columns keep the most recent one plus a count.
-- Only Stripe's own error code and decline code are stored, never card data.
ALTER TABLE users ADD COLUMN card_refusal_code TEXT;
ALTER TABLE users ADD COLUMN card_refusal_decline_code TEXT;
ALTER TABLE users ADD COLUMN card_refusal_at TEXT;
ALTER TABLE users ADD COLUMN card_refusal_count INTEGER NOT NULL DEFAULT 0;
