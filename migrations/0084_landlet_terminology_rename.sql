-- N43 (Control Room): owner direction to eliminate "lánd" as a separate
-- word everywhere, standardizing on "lándlet" as the sole umbrella term for
-- a plot of any size. Internally that means the plain-ASCII "landlet"
-- convention (src/main.js's own "no accent internally" note) replaces the
-- handful of places that still say bare "land" — except land_cap_m2/
-- LAND_CAP_*/"Land Cap" (migrations/0050), which the owner explicitly
-- confirmed stays as-is: it's a per-BUILDER aggregate across every landlet
-- they own, not a property of any one landlet, so "Landlet Cap" would
-- misleadingly read as capping a single plot.
--
-- Deliberately does NOT touch the JSON API surface (`landClass`/`landType`
-- stay exactly as-is in every request/response body, and the
-- /api/land-candidate(s) route paths are untouched) — only the internal
-- SQL identifiers change, following this migration's own precedent
-- (0070_higgles_rename.sql: rename the storage, never mind exposing it
-- with matching camelCase, which is a separate, much larger, genuinely
-- breaking API-contract question this PR isn't making unilaterally).
-- worker/index.js's own row-mapping functions (landletFromRow,
-- candidateFromRow, etc.) are the translation layer, same as always.
--
-- Same "rename only, RENAME COLUMN/RENAME TO both work directly on
-- D1" precedent as 0070 — no FK to either renamed column exists (FKs here
-- reference landlet_id/ring_id, never land_class/land_type), so this
-- carries none of migration 0056/0064's own documented "full table
-- rebuild fails against real D1 when another table holds a foreign key
-- into it" risk; only the land_candidate_rings table rename below touches
-- an FK'd table at all, and RENAME TO (not a rebuild) is exactly the safe
-- form 0070 already proved out for that too.

ALTER TABLE landlets RENAME COLUMN land_class TO landlet_class;
ALTER TABLE landlets RENAME COLUMN land_type TO landlet_type;

-- landlet_candidates.land_class: the one column here referenced by a
-- trigger's own UPDATE OF column list (migrations/0018) — dropped and
-- recreated under the renamed column rather than relying on RENAME
-- COLUMN's automatic trigger-body rewriting, so this doesn't depend on
-- exactly which SQLite behavior D1's engine implements.
DROP TRIGGER protect_land_candidate_ring_member_geometry;
ALTER TABLE landlet_candidates RENAME COLUMN land_class TO landlet_class;
CREATE TRIGGER protect_landlet_candidate_ring_member_geometry
BEFORE UPDATE OF area_m2, center_x_m, center_y_m, landlet_class, polygon_json, ring_id
ON landlet_candidates
WHEN OLD.ring_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'generated ring candidates are immutable');
END;

-- land_candidate_rings -> landlet_candidate_rings: RENAME TO itself
-- updates the FK reference inside landlet_candidates.ring_id automatically
-- (same as 0070's daller_earnings_events -> higgles_earnings_events), but
-- — also like 0070 — leaves every dependent index/trigger's own NAME
-- unchanged, so each is dropped and recreated below purely for naming
-- consistency; their behavior is byte-for-byte identical to before,
-- just renamed and pointed at the table's new name.
DROP TRIGGER protect_land_candidate_ring_member_delete;
DROP INDEX idx_land_candidate_rings_bounds;
DROP INDEX idx_land_candidate_rings_listing;
DROP INDEX idx_land_candidate_rings_adjacent_parent;
DROP TRIGGER reject_overlapping_land_candidate_ring;
DROP TRIGGER reject_mismatched_adjacent_land_candidate_ring;
DROP TRIGGER validate_land_candidate_ring_adjacency_parent;

ALTER TABLE land_candidate_rings RENAME TO landlet_candidate_rings;

CREATE TRIGGER protect_landlet_candidate_ring_member_delete
BEFORE DELETE ON landlet_candidates
WHEN OLD.ring_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'generated ring candidates are immutable');
END;

CREATE INDEX idx_landlet_candidate_rings_bounds
ON landlet_candidate_rings(inner_radius_m, outer_radius_m);

CREATE INDEX idx_landlet_candidate_rings_listing
ON landlet_candidate_rings(created_at, ring_id);

CREATE UNIQUE INDEX idx_landlet_candidate_rings_adjacent_parent
ON landlet_candidate_rings(adjacent_to_ring_id)
WHERE adjacent_to_ring_id IS NOT NULL;

CREATE TRIGGER reject_overlapping_landlet_candidate_ring
BEFORE INSERT ON landlet_candidate_rings
WHEN EXISTS (
  SELECT 1 FROM landlet_candidate_rings
  WHERE inner_radius_m < NEW.outer_radius_m - 0.0000001
    AND outer_radius_m > NEW.inner_radius_m + 0.0000001
)
BEGIN
  SELECT RAISE(ABORT, 'generated ring radial overlap');
END;

CREATE TRIGGER reject_mismatched_adjacent_landlet_candidate_ring
BEFORE INSERT ON landlet_candidate_rings
WHEN EXISTS (
  SELECT 1 FROM landlet_candidate_rings
  WHERE (ABS(outer_radius_m - NEW.inner_radius_m) <= 0.0000001
      OR ABS(inner_radius_m - NEW.outer_radius_m) <= 0.0000001)
    AND COALESCE(boundary_signature, '') <> COALESCE(NEW.boundary_signature, '')
)
BEGIN
  SELECT RAISE(ABORT, 'generated ring boundary mismatch');
END;

CREATE TRIGGER validate_landlet_candidate_ring_adjacency_parent
BEFORE INSERT ON landlet_candidate_rings
WHEN NEW.adjacent_to_ring_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM landlet_candidate_rings AS parent
  WHERE parent.ring_id = NEW.adjacent_to_ring_id
    AND ABS(parent.outer_radius_m - NEW.inner_radius_m) <= 0.0000001
    AND COALESCE(parent.boundary_signature, '') = COALESCE(NEW.boundary_signature, '')
)
BEGIN
  SELECT RAISE(ABORT, 'generated ring adjacency parent mismatch');
END;
