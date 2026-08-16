-- starter-landlet was seeded 'claimed' with no owner in 0001_initial.sql,
-- back when it was the app's only landlet and always-being-edited was the
-- intended default. Once the world/claim system and organic mosaic
-- generation shipped, generate-mosaic (see worker/index.js) started
-- writing the origin cell's real polygon onto starter-landlet directly --
-- but, before this migration's companion code fix, only ever touched its
-- geometry, never its status. So it stayed permanently "claimed" by
-- nobody: unclaimable by any real builder, and invisible to the
-- builder-delete release logic (which only releases landlets matching a
-- deleted builder's owner_builder_id -- starter-landlet's was always
-- NULL). One-time fix: release it into the same greenbelt/claimable state
-- every other successfully-generated landlet reaches, unless it has
-- genuinely been claimed by a real builder since.
UPDATE landlets
SET status = 'greenbelt',
    generated_at = COALESCE(generated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    claimable_at = COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE landlet_id = 'starter-landlet' AND status = 'claimed' AND owner_builder_id IS NULL;
