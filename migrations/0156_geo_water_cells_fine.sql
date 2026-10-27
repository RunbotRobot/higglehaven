-- #2805 (sub-issue of #2804, water-first/variable-size landlet generation):
-- a higher-granularity companion to geo_water_cells (migrations/0128).
-- That table's own center-point classifier (isNearWaterCell/
-- applyRealWaterClassification, worker/lib/world-generation.js) stays
-- exactly as it is -- #2805's own scope note is explicit that it isn't
-- touched by this work -- but a shape-respecting generator (#2806) needs
-- water queryable at a precision finer than that table's real stored
-- spacing (25m, confirmed against scripts/ingest-geo-data.mjs's own
-- --spacing default and migrations/0128's real seed data), and also needs
-- real river/stream geometry, which geo_water_cells never ingested at all.
--
-- Same shape as geo_water_cells, same reasoning for denormalizing
-- spacing_m onto every row (a consumer needs it alongside the coordinates
-- to know how close "near" is, and this dataset stays small enough that a
-- join buys nothing) -- just fed by a second, finer ingestion pass over
-- both lakes and rivers (scripts/ingest-geo-data.mjs's own fine-pass
-- additions, #2805) instead of the original lakes-only coarse pass.
-- worker/geoData.js's GEO_WATER_FINE_GRID_SPACING_M constant is this
-- table's own intended spacing, shared with the ingestion script so both
-- sides of the deterministic fixed-origin sampling lattice
-- scripts/ingest-geo-data.mjs:main() builds (anchored at world (0,0),
-- stepping by spacing_m, radius-clipped) agree on it without duplicating
-- the number -- see that constant's own comment for why a consumer can't
-- just read spacing_m off a row when a queried region happens to contain
-- no water at all.
--
-- Not yet consumed by anything: worker/lib/world-generation.js's new
-- isWaterAtFinePoint/fractionOfRegionWater query helpers (#2805) read this
-- table, but no real generation path calls them yet -- wiring a shape-
-- respecting generator into real candidate generation is #2806's scope,
-- not this one's. Same "produces a dataset a future generation step can
-- consult, doesn't wire it in" boundary #219/#2012's own original water
-- ingestion already drew.
CREATE TABLE geo_water_cells_fine (
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  spacing_m REAL NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (x_m, y_m)
);
