-- #645 (sub-issue of #616, itself sub-issue of #350): 1099-K/1099-NEC
-- form-record data model. One row per (user, tax year, form type) --
-- 1099-k for a seller's real-money payout income, 1099-nec for a
-- builder's daller-commission income (per #350's own research: the
-- daller side is never TPSO-settled the way the Stripe side is, so it
-- doesn't qualify for 1099-K; still flagged there as needing a real tax
-- professional's sign-off before anything is actually filed).
--
-- gross_income_cents is a snapshot taken at generation time, not a live
-- computed value -- once a form is approved (or filed), its own numbers
-- must not silently drift if more income posts later in the year; see
-- worker/index.js's upsertTax1099Draft, which only ever refreshes a row
-- still sitting in 'draft'.
--
-- filed_at/filing_reference stay NULL until #646 wires up real e-filing
-- transmission against a vendor account the owner still needs to
-- provision -- nothing in this migration assumes a vendor is chosen.
CREATE TABLE tax_1099_forms (
  form_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('1099-k', '1099-nec')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'filed', 'voided')),
  gross_income_cents INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  approved_at TEXT,
  filed_at TEXT,
  filing_reference TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, tax_year, form_type)
);

-- The admin review list's own primary query: every form for a given year.
CREATE INDEX idx_tax_1099_forms_year ON tax_1099_forms(tax_year);
