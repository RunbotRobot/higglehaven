-- #3108: when Tripo reports a finished model but our own storage step fails
-- transiently (R2/D1/network), the job now stays 'processing' and the store is
-- retried on the next poll or webhook delivery instead of failing the paid job
-- permanently. store_attempts counts those retries so a persistent fault gives
-- up after a few tries rather than re-downloading the model until the
-- 15-minute expiry sweep.
ALTER TABLE video_generation_jobs ADD COLUMN store_attempts INTEGER NOT NULL DEFAULT 0;
