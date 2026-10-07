-- #1410: POST /tax/admin-forms/:formId/file made the real, irreversible
-- outbound call to the e-filing vendor BEFORE its own atomic
-- status='approved' guard -- two concurrent /file requests on the same
-- form could both pass the pre-check and both transmit, producing two
-- distinct real federal filings for the same payee/tax year. Fixing this
-- needs a transient claimed state (status flips to 'filing' atomically
-- *before* the external call, then to 'filed' only after it succeeds, or
-- back to 'approved' if it fails) -- the same claim-before-external-call
-- shape claimOrResumeSellerPayout/claimPurchasesForPayout already use for
-- seller payouts, just via a status value here since this table has no
-- spare nullable timestamp column to claim through instead.
--
-- Same plain-rebuild shape migrations/0103_tax_1099_forms_user_id_set_null.sql
-- already used for this exact table (no children reference it, so no
-- cascading-drop hazard) -- SQLite can't ALTER an existing CHECK
-- constraint in place, only recreate the table with the new one.
CREATE TABLE tax_1099_forms_new (
  form_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  tax_year INTEGER NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('1099-k', '1099-nec')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'filing', 'filed', 'voided')),
  gross_income_cents INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  approved_at TEXT,
  filed_at TEXT,
  filing_reference TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payee_email TEXT,
  payee_tax_id_encrypted TEXT,
  payee_tax_form_type TEXT CHECK (payee_tax_form_type IN ('w9', 'w8ben')),
  UNIQUE (user_id, tax_year, form_type)
);
INSERT INTO tax_1099_forms_new SELECT * FROM tax_1099_forms;

DROP TABLE tax_1099_forms;
ALTER TABLE tax_1099_forms_new RENAME TO tax_1099_forms;

CREATE INDEX idx_tax_1099_forms_year ON tax_1099_forms(tax_year);
