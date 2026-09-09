-- docs/SPEC.md §6 registration gate: age attestation plus a credit-card-or-
-- government-ID verification requirement. #556, owner-confirmed sequencing
-- (Control Room, 2026-09-09): build now while the app is still
-- password-gated to friends and family, ahead of the age/ID gate actually
-- being enforced against real sign-ups. 'id_verified' fills in once #589
-- (Didit integration) lands; only 'none'/'credit_card' are reachable today.
ALTER TABLE users ADD COLUMN age_attested_at TEXT;
ALTER TABLE users ADD COLUMN trust_tier TEXT NOT NULL DEFAULT 'none' CHECK (trust_tier IN ('none', 'credit_card', 'id_verified'));
-- Stripe's own card.funding value ("credit"/"debit"/"prepaid") for
-- whichever card was last checked, kept even for a rejected debit/prepaid
-- attempt so a builder's own account view can explain why they're still
-- 'none' instead of leaving it a mystery.
ALTER TABLE users ADD COLUMN card_funding TEXT;
