-- Founding/pioneer recognition (docs/SPEC.md §3: "permanent 'Pioneer'
-- profile badge... Explicitly no larger starter plot for founding
-- builders... Recognition stays reputational/historical only."). Only the
-- badge itself is built here — the spec's separate "founding history" page
-- (the real "nail-chalice" launch-day lore) isn't something a dev session
-- can honestly fabricate; that's real narrative content only the operator
-- can supply, so it's left for later.
--
-- is_pioneer lives on the builder, not derived live from landlet
-- ownership, so the distinction survives even if that builder later
-- releases their land (spec: "permanent"). At most one builder holds it at
-- a time — see the claim endpoint in worker/index.js, which grants it to
-- the very next successful claim only when nobody currently holds it (so
-- deleting the pioneer builder's account, the only way today to lose a
-- claim outright, frees the distinction for a future claimer rather than
-- leaving it permanently unclaimable).
ALTER TABLE builders ADD COLUMN is_pioneer INTEGER NOT NULL DEFAULT 0;

-- Backfill: whichever already-existing builder owns the earliest-claimed
-- landlet (by claimable_at, falling back to created_at for older rows
-- that predate that column) becomes the pioneer retroactively, the same
-- "don't erase builders who got here before this feature shipped"
-- reasoning migrations/0032's own backfill already follows.
UPDATE builders
SET is_pioneer = 1
WHERE builder_id = (
  SELECT owner_builder_id FROM landlets
  WHERE owner_builder_id IS NOT NULL AND status = 'claimed'
  ORDER BY COALESCE(claimable_at, created_at), landlet_id
  LIMIT 1
);
