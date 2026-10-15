-- #2067 (leaf sub-issue of #1973, part of #1947): per-builder opt-in for
-- an email alert when a placed product sells out, layered on top of the
-- dashboard notification sweepSoldOutTemplateInstances already fires
-- unconditionally (see worker/index.js) -- off by default so existing
-- behavior for every current builder is unchanged until they opt in.
ALTER TABLE builders ADD COLUMN notify_sold_out_email INTEGER NOT NULL DEFAULT 0;
