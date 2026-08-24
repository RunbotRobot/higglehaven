-- Opt-in sharing to a community bundle tab (see docs/SPEC.md's Bundles
-- section: "Private by default; explicit opt-in sharing to a community
-- bundle tab"). A shared bundle is still owned by whoever created it —
-- this only controls whether other builders can see and place it, not
-- whether they can edit or delete it (see handleBundles' own ownership
-- comment in worker/index.js).
ALTER TABLE bundles ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

-- Partial index: the community listing only ever queries shared = 1, and
-- most bundles are expected to stay private, so indexing just the shared
-- rows keeps this small regardless of how many private bundles exist.
CREATE INDEX idx_bundles_shared ON bundles(created_at) WHERE shared = 1;
