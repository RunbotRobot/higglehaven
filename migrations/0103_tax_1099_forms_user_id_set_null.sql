-- #1147 (sub-issue of #1145, real account deletion): tax_1099_forms.user_id
-- was the one remaining `REFERENCES users(user_id)` FK still using SQLite's
-- implicit CASCADE-on-delete behavior for data the owner explicitly wants
-- *retained* through deletion -- "Retain financial and tax records...
-- disconnected from any live personal profile rather than deleted
-- outright" (#1145's own body). A hard delete of a `users` row would have
-- silently destroyed every approved/filed 1099 record for that person,
-- the opposite of what #1145 asks for. Switching to ON DELETE SET NULL
-- applies the same "keep the record, drop the live reference" pattern
-- 0062/0086/0091/0093 already used for purchases.builder_id/
-- higgles_redemptions.builder_id/sellers.user_id/builders.user_id.
--
-- SET NULL alone isn't enough here, unlike those other tables: this table
-- has no other columns identifying who the form is for or what to file --
-- gross_income_cents is already a point-in-time snapshot (see this table's
-- own comment in migrations/0081), but the payee's email and tax ID have
-- always been read live via a JOIN against `users` (see worker/index.js's
-- admin-forms list and the /file route). Once user_id can go NULL, that
-- join silently drops the row from the admin review list and /file loses
-- the tax ID it needs to transmit -- an approved-but-not-yet-filed form
-- would become permanently unfilable the moment the payee's account is
-- deleted. payee_email/payee_tax_id_encrypted/payee_tax_form_type are new
-- snapshot columns, captured once (at /admin-forms/:id/approve, the point
-- where the code already confirms live paperwork is on file -- see
-- worker/index.js), so an orphaned form stays reviewable and filable on
-- its own, no live `users` row required. A still-'draft' form has no
-- snapshot yet by design (nothing to snapshot before an admin confirms
-- paperwork is on file) -- see the coordination note on #1145 about why
-- #1146 should not strip tax_id_encrypted/tax_form_type/
-- tax_form_completed_at from a revoked account in the meantime.
--
-- No existing children reference tax_1099_forms, so this is a plain
-- rebuild (no cascading-drop hazard like migrations/0093's builders
-- rebuild had to work around).
CREATE TABLE tax_1099_forms_new (
  form_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  tax_year INTEGER NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('1099-k', '1099-nec')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'filed', 'voided')),
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
INSERT INTO tax_1099_forms_new (form_id, user_id, tax_year, form_type, status, gross_income_cents, generated_at, approved_at, filed_at, filing_reference, updated_at)
  SELECT form_id, user_id, tax_year, form_type, status, gross_income_cents, generated_at, approved_at, filed_at, filing_reference, updated_at FROM tax_1099_forms;

DROP TABLE tax_1099_forms;
ALTER TABLE tax_1099_forms_new RENAME TO tax_1099_forms;

CREATE INDEX idx_tax_1099_forms_year ON tax_1099_forms(tax_year);
