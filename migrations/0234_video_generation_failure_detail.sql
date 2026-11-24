-- #4122: the owner's first real video-to-3D run failed with "We couldn't retrieve the generated model" and
-- the row could not say why: the provider had reported success, and storing its output threw one of three
-- fatal errors (download refused, over the size cap, not a GLB we accept) whose reason the catch block
-- replaced with a generic sentence. This keeps the real reason, admin-only (never returned to the builder),
-- as a small JSON object: which failure, HTTP status, byte length, content type, the validator's message and
-- the keys the provider's output held.
ALTER TABLE video_generation_jobs ADD COLUMN failure_detail TEXT;
