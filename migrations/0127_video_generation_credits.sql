-- #1993 (sub-issue of #1976): a per-builder balance of free video-to-3D
-- generation credits, earned by collecting a credit orb in the world
-- (#1994/#1995) and spent at upload time (handleVideoGenerationJobCreate
-- in worker/index.js). Defaults to 0 so nothing changes for any existing
-- builder until they actually collect one -- today's only gate on this
-- flow is a plain rate limit, with no credit/balance concept anywhere.
ALTER TABLE builders ADD COLUMN video_generation_credits INTEGER NOT NULL DEFAULT 0;
