-- #3040 (sub-issue 1/3 of #3031, docs/SPEC.md §6): the admin-initiated
-- record that a confirmed moderation decision is being reported to NCMEC.
-- Owner approved building this 2026-11-03. This table is only the record:
-- nothing here, or anywhere in this sub-issue, submits anything externally
-- (that is #3042, blocked on NCMEC ESP registration), and evidence
-- preservation is #3041.
--
-- Insert-only, enforced here in the schema and not merely by the API
-- having no update/delete route: the two triggers below abort any UPDATE
-- or DELETE against this table, so a later code path, a console session,
-- or a bulk cleanup cannot quietly alter or drop a legal-reporting record.
-- (A future, deliberate retention-expiry job would have to drop these
-- triggers in its own reviewed migration.)
--
-- decision_type/decision_id point at the confirmed admin decision the
-- report came from, never at raw flag counts (standing decision:
-- "Moderation actions key on confirmed violations"): 'account_suspension'
-- is account_suspensions.suspension_id, 'content_removal' is
-- moderation_removal_snapshots.snapshot_id. UNIQUE(decision_type,
-- decision_id) means one report per decision, which keeps #3042's eventual
-- submission from ever double-reporting the same decision.
--
-- Deliberately NO foreign keys, same reasoning as
-- account_moderation_decisions.subject_builder_id (migrations/0110): this
-- is a permanent record that must survive the reported account, the
-- initiating admin, and the content itself all later being deleted.
-- content_refs_json holds identifiers only ({sourceTable, sourceId}
-- pairs), never content: the owner's 2026-10-20 rule for sexual_content
-- ("not in a snapshot, not even as a text fragment") stays intact here.
--
-- Admin-only. Nothing user-facing may reference this table: it is not part
-- of the account data export and no notification is ever sent from it.
CREATE TABLE ncmec_reports (
  report_id TEXT PRIMARY KEY,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('account_suspension', 'content_removal')),
  decision_id TEXT NOT NULL,
  reported_user_id TEXT NOT NULL,
  content_refs_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  reported_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (decision_type, decision_id)
);

CREATE INDEX idx_ncmec_reports_created_at ON ncmec_reports (created_at DESC);
CREATE INDEX idx_ncmec_reports_reported_user ON ncmec_reports (reported_user_id, created_at DESC);

CREATE TRIGGER ncmec_reports_no_update
BEFORE UPDATE ON ncmec_reports
BEGIN
  SELECT RAISE(ABORT, 'ncmec_reports rows are immutable');
END;

CREATE TRIGGER ncmec_reports_no_delete
BEFORE DELETE ON ncmec_reports
BEGIN
  SELECT RAISE(ABORT, 'ncmec_reports rows are immutable');
END;
