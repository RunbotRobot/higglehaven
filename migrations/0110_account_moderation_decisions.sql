-- #1405 (sub-issue of #1404, "AI-driven account-moderation decisions"):
-- foundational audit-trail table for any AI-made account-moderation
-- judgment call -- the owner's own framing (see #1404) is "run higglehaven
-- without ever hiring human employees, with Claude acting in place of
-- traditional staff," backed by a mandatory audit trail so a decision like
-- this is never a black box after the fact. First concrete consumer is the
-- Stripe reinstatement flow (#1065/#1406/#1407), but this table is
-- deliberately not Stripe-specific -- decision_type/subject_ref carry the
-- case-specific shape so the same table can log whatever other
-- account-moderation call comes next, mirroring how control_room_tasks
-- (migrations/0082) stays generic across issue/pr/feedback/question kinds
-- rather than growing a new table per case.
--
-- subject_builder_id is deliberately NOT a FK, same reasoning as
-- purchases.seller_id (migrations/0051) and seller_feedback.seller_id
-- (migrations/0098): this is a permanent historical record of a decision
-- that was made, and must survive the builder it concerned later deleting
-- their own account -- the decision itself (and its reasoning) stays
-- auditable either way.
--
-- outcome's CHECK deliberately excludes a plain "approved"-by-default
-- path: #1404's own design note is explicit that the two failure modes
-- aren't symmetric for a money/trust decision (a wrongful delay is
-- recoverable, a wrongful approval risks real fraud), so 'escalated' is a
-- first-class outcome alongside 'approved'/'denied', not an afterthought.
--
-- review_status/reviewed_by/review_outcome/review_notes/reviewed_at back
-- #1404's fourth guardrail, the redundant secondary/batch review of a
-- sample of AI-made decisions -- left nullable/pending here since the
-- actual review cadence and mechanism is still its own open,
-- owner-judgment sub-issue of #1404.
CREATE TABLE IF NOT EXISTS account_moderation_decisions (
  decision_id TEXT PRIMARY KEY,
  decision_type TEXT NOT NULL,
  subject_builder_id TEXT,
  subject_ref TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'denied', 'escalated')),
  rubric_version TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed')),
  reviewed_by TEXT,
  review_outcome TEXT CHECK (review_outcome IN ('confirmed', 'overturned')),
  review_notes TEXT,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_moderation_decisions_subject ON account_moderation_decisions(subject_builder_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_moderation_decisions_decision_type ON account_moderation_decisions(decision_type, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_moderation_decisions_review_status ON account_moderation_decisions(review_status, decided_at);
