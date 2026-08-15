-- A shared, cross-device roster of builder identities. Still not real auth
-- (see docs/API.md) — anyone can list, create, rename, or delete any of
-- these — but the list itself now lives server-side instead of being
-- reinvented independently in every browser's localStorage, so switching
-- devices sees the same builders.

CREATE TABLE builders (
  builder_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Backfill from existing ownership so nobody who already claimed a landlet
-- under the old client-only identity scheme disappears from the roster.
INSERT INTO builders (builder_id, label)
SELECT DISTINCT owner_builder_id, 'Builder ' || substr(owner_builder_id, 9, 8)
FROM landlets
WHERE owner_builder_id IS NOT NULL;
