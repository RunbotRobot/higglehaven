-- #3142 (owner decision 2026-11-05, "One alias per person"): a person's name
-- is the account's username; builders.label is only a copy of it. Until now
-- PATCH /api/builders/:id edited the label on its own, so the two could
-- drift. The rename path now sets the username and the label together; this
-- brings any already-drifted builder back in line. A builder is left as it
-- is when another builder already holds its username as a label (case-
-- insensitively), since renaming it would break the label uniqueness the
-- rename path enforces; those can be looked up as builders whose label
-- differs from their account's username.
CREATE TABLE builder_label_backfill_3142 (
  builder_id TEXT PRIMARY KEY REFERENCES builders(builder_id) ON DELETE CASCADE,
  old_label TEXT NOT NULL,
  new_label TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO builder_label_backfill_3142 (builder_id, old_label, new_label)
SELECT b.builder_id, b.label, u.username
FROM builders b
JOIN users u ON u.user_id = b.user_id
WHERE b.label != u.username
  AND NOT EXISTS (
    SELECT 1 FROM builders other
    WHERE other.label = u.username COLLATE NOCASE AND other.builder_id != b.builder_id
  );

UPDATE builders
SET label = (SELECT new_label FROM builder_label_backfill_3142 r WHERE r.builder_id = builders.builder_id)
WHERE builder_id IN (SELECT builder_id FROM builder_label_backfill_3142);
