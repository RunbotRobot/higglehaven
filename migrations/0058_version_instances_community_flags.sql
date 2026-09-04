-- Same reasoning 0034_instance_crop.sql and 0036 (instance_scale) already
-- applied to crop_json/scale: a published snapshot shouldn't silently drop
-- an instance's community-sign/calendar status just because it went
-- through a version save/restore. 0041_community_signs.sql and
-- 0042_community_calendar.sql added these flags only to placed_instances,
-- never to version_instances -- an oversight this closes.
ALTER TABLE version_instances ADD COLUMN is_community_sign INTEGER NOT NULL DEFAULT 0;
ALTER TABLE version_instances ADD COLUMN is_community_calendar INTEGER NOT NULL DEFAULT 0;
