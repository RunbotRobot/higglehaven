-- Builder-side Stripe Connect Custom account state (#624, sub-issue of
-- #349/#324) — mirrors migrations/0068_seller_stripe_connect.sql exactly,
-- the prerequisite for a builder to ever cash out a real-money payout of
-- their higgles balance (#625). Same "no PII stored here" property: legal
-- name, DOB, SSN, bank details all go straight to Stripe's Accounts API
-- and are discarded once submitted, not persisted in this table.
ALTER TABLE builders ADD COLUMN stripe_account_id TEXT;
ALTER TABLE builders ADD COLUMN stripe_onboarding_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE builders ADD COLUMN stripe_requirements_due TEXT;
ALTER TABLE builders ADD COLUMN stripe_updated_at TEXT;
