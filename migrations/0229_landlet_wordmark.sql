-- #3781 (part of #3771): a landlet's chosen lettering style and colour pair
-- for its wordmark. Role-scoped (the builder's landlet, not the account).
-- 'default' means the default look (#3770); the legal ids live in one file,
-- shared/wordmark-set.js, read by both the Worker and the client.
ALTER TABLE landlets ADD COLUMN wordmark_style TEXT NOT NULL DEFAULT 'default';
ALTER TABLE landlets ADD COLUMN wordmark_colors TEXT NOT NULL DEFAULT 'default';
