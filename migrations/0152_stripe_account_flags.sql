-- #1407 (sub-issue of #1404, gated on #1405/#1406/#1065 all landing first):
-- flag history for a builder's or seller's Stripe Connect account, so the
-- owner-approved reinstatement rubric (#1406's own comment, quoted in full
-- in handleStripeReinstatementRequest's own header) is actually computable
-- from real data instead of staying conceptual. A "flag" here is an
-- admin-recorded incident -- Stripe account restricted/disabled on
-- suspected risk signals, or a confirmed fraud/chargeback determination --
-- not the AI-made reinstatement *decision* itself (that's a separate
-- concern, logged to account_moderation_decisions, migrations/0110).
--
-- subject_type/subject_id (not a FK into builders/sellers) mirrors
-- purchases.seller_id's own "survive the row it concerns being deleted
-- later" reasoning (migrations/0051) -- a flag's own history must stay
-- auditable even if the flagged account is later removed.
--
-- disposition's CHECK mirrors #1406's own two-way rubric split exactly:
-- 'confirmed_fraud' (chargebacks/disputes resolved against the subject, or
-- a Stripe fraud determination) is a hard, permanent ban with no
-- reinstatement path at all; 'suspected' (restricted on risk signals,
-- nothing adjudicated) is eligible for reinstatement subject to the
-- rubric's cooling-off/re-verification/reinstatement-cap gates.
CREATE TABLE IF NOT EXISTS stripe_account_flags (
  flag_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('builder', 'seller')),
  subject_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('confirmed_fraud', 'suspected')),
  reason TEXT NOT NULL,
  stripe_account_id_at_flag_time TEXT,
  flagged_by TEXT NOT NULL,
  flagged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Looked up by subject when computing flag count (the "3rd flag ever =
-- permanent ban" rule) and the most recent flag's own flagged_at (the
-- 90-day cooling-off window's start).
CREATE INDEX IF NOT EXISTS idx_stripe_account_flags_subject
  ON stripe_account_flags(subject_type, subject_id, flagged_at DESC);
