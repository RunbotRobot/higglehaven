-- #2013 (sub-issue of #2012, following up on #1266): gives the Worker a way
-- to actually read the real-world water-cell data scripts/ingest-geo-data.mjs
-- can produce. That script already runs real USGS elevation/hydrology
-- queries and writes a sparse {x, y} water-cell grid to a local JSON file --
-- but Cloudflare Workers have no filesystem at request time, so until this
-- table existed there was nowhere for a deployed Worker to ever read that
-- data from. #2012's own body confirms this is the missing piece keeping
-- every real landlet-generation path "always buildable" despite the
-- landlet_type column (migrations 0064/0108) already being able to
-- represent water.
--
-- One row per sampled grid cell the ingestion script classified as real
-- pre-1916 water (its own sparse "water cells only" output format -- see
-- that script's header comment). spacing_m is carried on every row rather
-- than a separate ingestion-run table: this dataset is small (a few hundred
-- rows at most for any radius this world will need for a long while) and a
-- consumer needs spacing_m right alongside the coordinates to decide how
-- close is "near" this cell, so denormalizing it avoids a join for no real
-- storage cost.
CREATE TABLE geo_water_cells (
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  spacing_m REAL NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (x_m, y_m)
);

-- Real output of `node scripts/ingest-geo-data.mjs --radius=300 --spacing=25`
-- (run 2026-10-14), seeded directly rather than via a separate import
-- endpoint/script -- same "schema + real seed data in one migration"
-- precedent migrations/0001_initial.sql already set for world_settings/
-- starter-landlet. 300m comfortably exceeds the world's current radius
-- (~82m as of this writing, growing 10m per expansion) without the cost of
-- ingesting a much larger area this world won't need for a long while; this
-- script can be re-run for a wider radius in a later migration once the
-- world's real radius approaches this one, per the script's own "regenerate
-- offline on major changes" doc comment.
INSERT INTO geo_water_cells (x_m, y_m, spacing_m, generated_at) VALUES
  (-275, -100, 25, '2026-10-14T01:44:16.991Z'),
  (-275, -75, 25, '2026-10-14T01:44:16.991Z'),
  (-250, -150, 25, '2026-10-14T01:44:16.991Z'),
  (-250, -125, 25, '2026-10-14T01:44:16.991Z'),
  (-250, -100, 25, '2026-10-14T01:44:16.991Z'),
  (-225, -175, 25, '2026-10-14T01:44:16.991Z'),
  (-225, -150, 25, '2026-10-14T01:44:16.991Z'),
  (-225, -125, 25, '2026-10-14T01:44:16.991Z'),
  (-200, -200, 25, '2026-10-14T01:44:16.991Z'),
  (-200, -175, 25, '2026-10-14T01:44:16.991Z'),
  (-200, -150, 25, '2026-10-14T01:44:16.991Z'),
  (-175, -225, 25, '2026-10-14T01:44:16.991Z'),
  (-175, -200, 25, '2026-10-14T01:44:16.991Z'),
  (-175, -175, 25, '2026-10-14T01:44:16.991Z'),
  (-150, -250, 25, '2026-10-14T01:44:16.991Z'),
  (-150, -225, 25, '2026-10-14T01:44:16.991Z'),
  (-150, -175, 25, '2026-10-14T01:44:16.991Z'),
  (-100, -275, 25, '2026-10-14T01:44:16.991Z'),
  (75, -275, 25, '2026-10-14T01:44:16.991Z'),
  (75, -250, 25, '2026-10-14T01:44:16.991Z'),
  (100, -275, 25, '2026-10-14T01:44:16.991Z'),
  (100, -250, 25, '2026-10-14T01:44:16.991Z'),
  (100, -225, 25, '2026-10-14T01:44:16.991Z'),
  (125, -250, 25, '2026-10-14T01:44:16.991Z'),
  (125, -225, 25, '2026-10-14T01:44:16.991Z'),
  (125, -150, 25, '2026-10-14T01:44:16.991Z'),
  (150, -250, 25, '2026-10-14T01:44:16.991Z'),
  (150, -225, 25, '2026-10-14T01:44:16.991Z'),
  (150, -200, 25, '2026-10-14T01:44:16.991Z'),
  (150, -175, 25, '2026-10-14T01:44:16.991Z'),
  (150, -150, 25, '2026-10-14T01:44:16.991Z'),
  (175, -225, 25, '2026-10-14T01:44:16.991Z'),
  (175, -200, 25, '2026-10-14T01:44:16.991Z'),
  (175, -175, 25, '2026-10-14T01:44:16.991Z'),
  (175, -150, 25, '2026-10-14T01:44:16.991Z'),
  (175, -75, 25, '2026-10-14T01:44:16.991Z'),
  (200, -200, 25, '2026-10-14T01:44:16.991Z'),
  (200, -125, 25, '2026-10-14T01:44:16.991Z'),
  (200, -100, 25, '2026-10-14T01:44:16.991Z'),
  (225, -175, 25, '2026-10-14T01:44:16.991Z'),
  (225, -150, 25, '2026-10-14T01:44:16.991Z'),
  (250, -150, 25, '2026-10-14T01:44:16.991Z'),
  (250, -125, 25, '2026-10-14T01:44:16.991Z');
