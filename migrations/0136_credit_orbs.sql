-- #1994 (sub-issue of #1976, "Orb-collection mechanic to ration free
-- video-to-3D generation credits within a hard $5/day budget"): a credit
-- orb is a server-spawned, no-builder-action-behind-it object that
-- appears in a random greenbelt landlet and is collected by whichever
-- builder walks up to it first (#1995's own job), crediting their
-- video_generation_credits balance (#1993) by one.
--
-- Confirmed via direct code read: nothing like this exists today -- no
-- random-selection query (`RANDOM()` appears nowhere in worker/index.js or
-- any prior migration) and no precedent anywhere for the server spawning a
-- visible object with no builder action behind it (every placed_instances
-- INSERT today is an authenticated builder's own POST).
--
-- `collected_at`/`collected_by_builder_id` are both nullable and always
-- set together, the same atomic terminal-state-guard idiom this codebase
-- already uses for didit_verification_sessions/purchases.paid_out_at/
-- video_generation_jobs.processed_at -- whichever request wins the
-- collect race applies the result, every loser's own
-- `WHERE collected_at IS NULL` update affects 0 rows.
--
-- landlet_id intentionally has no FK/ON DELETE behavior tying it to
-- landlets(landlet_id): a landlet is never deleted in this codebase (no
-- `DELETE FROM landlets` anywhere), only re-statused, so there is no
-- "orb outlives its landlet" case to defend against today, and adding an
-- unused ON DELETE clause would just be speculative.
CREATE TABLE credit_orbs (
  orb_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL DEFAULT 0,
  spawned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  collected_at TEXT,
  collected_by_builder_id TEXT REFERENCES builders(builder_id)
);

-- GET /api/credit-orbs' own "active (uncollected) orbs" query filters on
-- this; the scheduled spawn job also reads the most recent spawned_at
-- (across every orb, collected or not) as its "last spawn time" anchor --
-- see worker/index.js's spawnCreditOrbIfDue for why reusing this column
-- instead of a separate single-row state table.
CREATE INDEX idx_credit_orbs_collected_at ON credit_orbs(collected_at);
CREATE INDEX idx_credit_orbs_spawned_at ON credit_orbs(spawned_at);
