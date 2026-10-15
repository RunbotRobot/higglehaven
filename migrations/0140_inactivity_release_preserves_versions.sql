-- #1257 (owner-confirmed, 2026-10-13): docs/API.md's own DELETE
-- /api/builders comment has long described what an inactivity-triggered
-- land reclaim *should* do -- "clear the active build but keep the
-- builder's own version history, in case they come back" -- but when
-- #325 actually built that mechanism (autoAuctionInactiveLandlets), its
-- $0-no-bid resolution reused the exact same full-wipe cleanup a
-- voluntary $0 auction's no-bid release uses, permanently deleting
-- landlet_versions along with everything else. The owner confirmed the
-- comment's original intent is still correct: give the inactivity path a
-- gentler cleanup than the voluntary one.
--
-- inactivity_triggered distinguishes the two at resolution time --
-- autoAuctionInactiveLandlets sets it to 1 on insert; handleStartAuction
-- (every builder-initiated voluntary auction) never does, so it defaults
-- to 0.
ALTER TABLE auctions ADD COLUMN inactivity_triggered INTEGER NOT NULL DEFAULT 0 CHECK (inactivity_triggered IN (0, 1));

-- Simply skipping the DELETE FROM landlet_versions statement for the
-- inactivity-triggered case isn't safe on its own: GET
-- /api/landlets/:landletId/versions and the version-activate endpoint are
-- both keyed purely off landlet_id with no builder/ownership check tying
-- a version to who made it, so a landlet released to greenbelt this way
-- and later claimed by a totally different builder would inherit (and
-- could even activate) the previous, unrelated owner's old build.
-- Preserved versions need to move OFF the landlet entirely instead -- the
-- same "outlive the source landlet, keyed to the builder instead" shape
-- migrations/0080's own saved_level_layouts/saved_layout_instances
-- already established for the identical problem (#633), which this
-- mirrors column-for-column. version_id/source_instance_id are reused
-- verbatim from the originals (both already globally unique via
-- crypto.randomUUID() at creation time) rather than regenerated, so
-- resolveAuction's own archiving INSERTs are a straight re-parent, not a
-- re-snapshot.
CREATE TABLE IF NOT EXISTS archived_landlet_versions (
  version_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  -- Informational only, same SET NULL reasoning as saved_level_layouts'
  -- own source_landlet_id -- the source landlet has already changed
  -- hands (greenbelt, then possibly reclaimed by someone else) by the
  -- time this row is ever read, and losing that reference shouldn't
  -- destroy the archived version itself.
  source_landlet_id TEXT REFERENCES landlets(landlet_id) ON DELETE SET NULL,
  version_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archived_version_instances (
  version_id TEXT NOT NULL REFERENCES archived_landlet_versions(version_id) ON DELETE CASCADE,
  source_instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES catalog_templates(template_id) ON DELETE RESTRICT,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL,
  rotation_x_rad REAL NOT NULL DEFAULT 0,
  rotation_y_rad REAL NOT NULL DEFAULT 0,
  rotation_z_rad REAL NOT NULL DEFAULT 0,
  label TEXT,
  crop_json TEXT NOT NULL DEFAULT '{}',
  scale REAL NOT NULL DEFAULT 1,
  is_community_sign INTEGER NOT NULL DEFAULT 0,
  is_community_calendar INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, source_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_archived_landlet_versions_builder_id ON archived_landlet_versions(builder_id, created_at DESC);
