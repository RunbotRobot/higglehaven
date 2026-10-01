-- #1097 (sub-issue of #1095, the multiplayer-presence tracking issue):
-- foundation for "seeing other avatars live in the shared world" --
-- live, ephemeral per-builder position state, independent of whichever
-- transport #1095's own transport-decision sub-issue (#1102) eventually
-- settles on. One row per currently-online builder, upserted on every
-- position report (see #1098) -- this is live state, not a growing log,
-- so there is no index on created_at/updated_at for history purposes,
-- only the staleness lookup #1099/#1101 need.
--
-- `landlet_id` has no foreign key -- a builder can be anywhere in the
-- shared world, including open ground between landlets, not just on one
-- a landlet row models; it is a free-form "which room/region is this
-- position being reported for" key for the GET endpoint (#1099) to scope
-- its query by, not a strict reference to the landlets table.
--
-- `ON DELETE CASCADE` on builder_id mirrors how this schema already
-- treats other purely-ephemeral per-builder state (e.g. notifications,
-- bundles) -- a deleted builder's live position has no reason to survive
-- them.
CREATE TABLE avatar_presence (
  builder_id TEXT PRIMARY KEY REFERENCES builders(builder_id) ON DELETE CASCADE,
  landlet_id TEXT,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  heading REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- #1099's GET endpoint scopes its query to "other avatars in this same
-- landlet/region" -- this is the index that query needs.
CREATE INDEX idx_avatar_presence_landlet_id ON avatar_presence(landlet_id, updated_at);
