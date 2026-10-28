-- #2842 (sub-issue of #2841, docs/SPEC.md §7's "Tax education (not advice)"
-- — jurisdiction-keyed, plain-language, regularly-updated general
-- informational summaries, explicitly not personalized advice,
-- human-reviewed before publishing, prioritized by expected builder
-- geography). This issue's own scope is just the storage + admin-editable
-- UI — surfacing this content to builders (#2843) and deciding who
-- authors/reviews it (#2844, owner judgment) are separate sub-issues.
--
-- Deliberately NOT keyed off the existing seller-payouts-tax.js W-9/W-8BEN
-- country field: that one lives inside payee_tax_id_encrypted (an
-- encrypted blob holding SSN/foreign-TIN alongside country), so it can't
-- be queried in plain SQL without a decrypt on every read, and using a
-- sensitive tax-identity field as the join key for a GENERAL, read-by-
-- anyone educational page would be a real scope-creep risk on data this
-- codebase otherwise keeps tightly encrypted. This table's own
-- country_code/state_code columns are a separate, non-sensitive
-- classification -- #2843's own surfacing logic decides how to map a
-- builder to one of these rows.
--
-- reviewed_at/reviewed_by gate whether an entry is live (SPEC's "human-
-- reviewed before publishing" requirement) -- same nullable-sentinel-
-- column idiom this schema already uses elsewhere for a gated state
-- (e.g. catalog_templates.flagged_hidden_at), rather than a separate
-- boolean the two columns could drift out of sync with.
CREATE TABLE tax_education_content (
  content_id TEXT PRIMARY KEY,
  -- ISO 3166-1 alpha-2 (e.g. "US", "GB"). Required -- every entry is
  -- scoped to at least a country; state_code narrows within one.
  country_code TEXT NOT NULL,
  -- State/province code, only meaningful when country_code = 'US' today
  -- (or any other country #2843 later decides needs sub-national
  -- granularity) -- NULL means "applies to the whole country".
  state_code TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- #2843's own surfacing lookup will filter by (country_code, state_code)
-- and the reviewed_at gate together -- this is that lookup's index.
CREATE INDEX idx_tax_education_content_jurisdiction
  ON tax_education_content(country_code, state_code);
