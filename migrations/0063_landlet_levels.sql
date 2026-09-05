-- docs/SPEC.md §1's vertical construction (issue #167, this table is
-- #168's sub-issue): multiple above/below-ground levels per lándlet,
-- gated by the same land cap as horizontal area rather than a separate
-- resource, with an asymmetric per-level cost — each level above ground
-- consumes progressively more cap (cross-section grows moving away from
-- Earth's center), each level below consumes progressively less (cone
-- converging toward the center). cap_consumed_m2 is computed once at
-- insert time via worker/earthCurvature.js's footprintScaleAtHeight and
-- stored (not recomputed live), so removing/re-adding a level can't
-- silently drift from what was actually charged.
--
-- level_index 0 (the ground level every lándlet already has, accounted
-- for by landlets.area_m2 itself) never gets a row here — this table
-- only tracks additional levels beyond that baseline. Positive indexes
-- are above ground, negative are below. The UNIQUE constraint also
-- backs the "can only add/remove the outermost level" adjacency rule
-- worker/index.js enforces: a level can't exist without every level
-- between it and the ground already existing.
CREATE TABLE landlet_levels (
  level_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL REFERENCES landlets(landlet_id) ON DELETE CASCADE,
  level_index INTEGER NOT NULL CHECK (level_index != 0),
  cap_consumed_m2 REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (landlet_id, level_index)
);

CREATE INDEX idx_landlet_levels_landlet_id ON landlet_levels(landlet_id);
