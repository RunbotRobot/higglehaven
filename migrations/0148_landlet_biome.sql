-- #2369 (sub-issue of #2368, docs/SPEC.md §1's "Macro-geography": "real,
-- permanent geographic features (lakes, rivers, mountains, biomes)"): gives
-- a landlet a place to hold a real biome classification, the same
-- "primitive before any consumer" shape migrations/0064 used for
-- `landlet_type` (water) ahead of #219/#220's own consumers.
--
-- Nullable rather than NOT NULL + CHECK, unlike `landlet_type`'s fixed
-- `'buildable' | 'water'` enum: the actual biome value set (lowland,
-- upland, alpine, ...) is #2370's own classification-design call, not
-- this issue's to pre-decide. A CHECK constraint locked in now would need
-- a second migration to loosen the moment #2370 picks real values --
-- nullable TEXT with no CHECK avoids that, at the cost of this migration
-- not itself enforcing a closed set. `src/main.js`'s existing ground-
-- texture fallback (~line 1263) already treats "no real biome data" as
-- its own bucket, so NULL is the correct default, not an empty string or
-- a placeholder like `landlet_type`'s own `'buildable'` default -- there's
-- no safe non-null default to fall back to the way "not water" safely
-- defaults to "buildable".
--
-- Additive column, same reasoning as migrations/0064/0108: both
-- `landlets` and `landlet_candidates` are referenced by other tables
-- (landlet_versions/auctions/landlet_levels/landlet_candidate_rings), so a
-- rebuild-requiring schema change carries the real D1 risk those
-- migrations' own comments document. `ALTER TABLE ... ADD COLUMN` needs
-- no rebuild and is fully backward compatible: every existing row becomes
-- NULL, i.e. unchanged from today's "no biome concept at all".
--
-- Nothing produces a non-null biome yet -- that's #2370 (classification
-- data) and #2371 (wiring into generation). This issue only makes the
-- data model capable of representing one.
ALTER TABLE landlets ADD COLUMN biome TEXT;
ALTER TABLE landlet_candidates ADD COLUMN biome TEXT;

-- Same immutability treatment migrations/0108 gave `landlet_type` on a
-- ring-generated candidate: biome is the same kind of per-plot
-- classification as `landlet_class`/`landlet_type` already protected by
-- this trigger, so it joins them rather than being left editable through
-- the one column the trigger doesn't know about yet.
DROP TRIGGER protect_landlet_candidate_ring_member_geometry;

CREATE TRIGGER protect_landlet_candidate_ring_member_geometry
BEFORE UPDATE OF area_m2, center_x_m, center_y_m, landlet_class, landlet_type, biome, polygon_json, ring_id
ON landlet_candidates
WHEN OLD.ring_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'generated ring candidates are immutable');
END;
