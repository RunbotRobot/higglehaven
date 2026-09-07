-- Stripe Connect Custom account state for a seller (#452, first leaf under
-- #347/#324's real-payment-processing tracking work — owner-confirmed
-- account type: Custom, meaning higglehaven builds its own onboarding UI
-- and Stripe stays entirely invisible to the seller, see #347's comments).
-- No PII (legal name, DOB, SSN, bank details) is ever stored here — those
-- go straight to Stripe's Accounts API and are discarded once submitted;
-- these columns only track the resulting Stripe-side account id and
-- onboarding progress, which is safe, non-sensitive bookkeeping.
ALTER TABLE sellers ADD COLUMN stripe_account_id TEXT;
ALTER TABLE sellers ADD COLUMN stripe_onboarding_status TEXT NOT NULL DEFAULT 'not_started';
-- JSON array of Stripe's own requirements.currently_due field names (e.g.
-- "individual.verification.document") — plain field-name strings, never
-- values, so safe to store and surface back to the seller as-is.
ALTER TABLE sellers ADD COLUMN stripe_requirements_due TEXT;
ALTER TABLE sellers ADD COLUMN stripe_updated_at TEXT;
