-- #1003: deleting a seller/builder (DELETE /api/sellers/:id, DELETE
-- /api/builders/:id) removed the row but left its connected Stripe Connect
-- account completely untracked -- the account kept existing in Stripe,
-- still holding real onboarding PII, with nothing left anywhere in this
-- app's own database recording which acct_... id it even was.
--
-- Owner's call (2026-10-06, issue-1003 comment): don't auto-delete or
-- deactivate the Stripe account at deletion time -- avoids conflicting
-- with #835's tax-retention requirement, and Stripe may refuse mid-tax-year
-- deletion anyway if 1099 reporting obligations are still pending. Instead,
-- snapshot the acct_... id into a retained/orphaned table before the live
-- reference disappears, same "keep the record, drop the live reference"
-- pattern #1147 already established for tax_1099_forms.user_id. Actual
-- deactivation is a separate later cleanup pass once a given tax year's
-- reporting is confirmed settled -- not this table's job.
CREATE TABLE retained_stripe_accounts (
  retained_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('seller', 'builder')),
  source_id TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL,
  stripe_onboarding_status TEXT,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_retained_stripe_accounts_source ON retained_stripe_accounts(source, source_id);
