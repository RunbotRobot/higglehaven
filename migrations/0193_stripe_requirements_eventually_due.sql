-- #2928: Stripe's account.requirements.eventually_due lists what Stripe will
-- ask for later (volume/time thresholds), before it blocks payouts. Stored
-- next to stripe_requirements_due (currently_due) so the payout panels can
-- offer Stripe's own onboarding step as an early heads-up. A JSON array of
-- Stripe's own requirement field names (never a value the person typed);
-- NULL for rows written before this migration, read as an empty list.
ALTER TABLE sellers ADD COLUMN stripe_requirements_eventually_due TEXT;
ALTER TABLE builders ADD COLUMN stripe_requirements_eventually_due TEXT;
