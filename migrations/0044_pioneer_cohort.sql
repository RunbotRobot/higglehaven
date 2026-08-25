-- Widens founding/pioneer recognition (migrations/0043) from a single
-- "first ever claimer" to a whole founding cohort — per-user direction:
-- "Pioneer status [should] extend to a larger population of early
-- adopters." Replaces the single is_pioneer boolean with a sequential
-- pioneer_rank (1, 2, 3, ...), assigned to each builder's first-ever
-- landlet claim, up to PIONEER_COHORT_SIZE (100, see worker/index.js) —
-- ranked, not just binary, so the badge can show *which* early adopter a
-- builder was and (per docs/SPEC.md §3's "grows in prestige over time")
-- read as more impressive as the platform's total population grows well
-- past this fixed founding hundred.
ALTER TABLE builders ADD COLUMN pioneer_rank INTEGER;

-- Backfill: rank every already-claimed builder by how early their first
-- claim landed (ties broken by builder_id for determinism), same
-- "don't erase builders who got here before this feature existed"
-- reasoning every other backfill in this migration history follows.
-- Ranking via UPDATE...FROM with a derived ROW_NUMBER() table rather than
-- a CREATE TEMP TABLE — D1 rejects temp-table DDL outright (SQLITE_AUTH),
-- confirmed by hand against a local D1 instance while writing this
-- migration.
UPDATE builders
SET pioneer_rank = ranked.rn
FROM (
  SELECT owner_builder_id AS builder_id,
         ROW_NUMBER() OVER (ORDER BY MIN(claimable_at), owner_builder_id) AS rn
  FROM landlets
  WHERE owner_builder_id IS NOT NULL AND status = 'claimed'
  GROUP BY owner_builder_id
) AS ranked
WHERE builders.builder_id = ranked.builder_id AND ranked.rn <= 100;

ALTER TABLE builders DROP COLUMN is_pioneer;
