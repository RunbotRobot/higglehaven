-- #3041 (sub-issue 2/3 of #3031, docs/SPEC.md §6): evidence preservation for
-- an admin-recorded NCMEC report (ncmec_reports, migrations/0176).
-- Owner decision 2026-11-05 (comment on #3041): preserve content ONLY for
-- items an admin has recorded an NCMEC report on, in a segregated,
-- admin-only evidence store that is excluded from every deletion and
-- cleanup path and auto-purged at the one-year mark. The 2026-10-20
-- 'sexual_content' keep-nothing rule (migrations/0168) stays in force for
-- every ordinary removal; it is overridden only by a filed report.
--
-- One row per report, written in the same atomic batch as the
-- ncmec_reports row (worker/lib/ncmec-reports.js), so a report can never
-- exist without its evidence row and vice versa.
--
-- Deliberately NO foreign keys and no reference from any other table, for
-- the same reason ncmec_reports has none: nothing the account, content or
-- admin lifecycle does (cascadeDeleteAccount, listing/template deletion,
-- the R2 orphan sweep, saved-layout cleanup, ...) can reach or cascade into
-- this table. It is not part of the account data export and nothing is
-- ever notified from it.
--
-- account_json / uploads_json: a snapshot, taken at report time, of the
-- reported account (never credentials or tax data) and of upload metadata
-- (catalog templates and video-to-3D jobs the account created). content_json
-- is an array with one entry per content reference: either
-- {status: 'preserved', row, r2Keys} (the live row and a copy of every
-- still-present R2 object it references, under the evidence prefix
-- 'ncmec-evidence/<report_id>/' in the MODELS bucket), or
-- {status: 'not_retained', reason} when the item no longer existed at
-- report time (for example a sexual_content removal made before the report,
-- which by the 2026-10-20 rule kept nothing).
--
-- Rows are immutable once written; the only permitted DELETE is the
-- scheduled retention purge (worker/lib/ncmec-evidence.js), which keys on
-- captured_at against a single constant in code so the retention period
-- can change without a schema change.
CREATE TABLE ncmec_evidence (
  evidence_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE,
  reported_user_id TEXT NOT NULL,
  account_json TEXT NOT NULL,
  uploads_json TEXT NOT NULL DEFAULT '[]',
  content_json TEXT NOT NULL DEFAULT '[]',
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_ncmec_evidence_captured_at ON ncmec_evidence (captured_at);

CREATE TRIGGER ncmec_evidence_no_update
BEFORE UPDATE ON ncmec_evidence
BEGIN
  SELECT RAISE(ABORT, 'ncmec_evidence rows are immutable');
END;
