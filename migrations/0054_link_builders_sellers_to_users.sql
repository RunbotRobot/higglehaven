-- Links builder/seller profiles to real accounts (migrations/0053_users_auth.sql),
-- the follow-up work that migration's own comment deliberately deferred.
-- Nullable, not backfilled: every builder/seller created before this
-- migration was a free-text dev-mode identity with no real account behind
-- it (see migrations/0032/0037's own comments — "anyone can list, create,
-- rename, or delete any of these") and there is no trustworthy way to
-- guess which, if any, real account a pre-existing label "belongs to." A
-- unique label was never even guaranteed, so guessing would risk silently
-- handing one real account someone else's existing landlets/products.
-- These orphaned rows are simply left as unreachable history — not
-- deleted (their landlets/catalog templates still reference them), just
-- never linkable to a login going forward. This is an acceptable, one-time
-- cost specifically because this app has no real users yet (pre-launch
-- dev/test data only); it would not be if real builders already depended
-- on these accounts.
--
-- Partial unique index (SQLite/D1 supports this) rather than a plain
-- UNIQUE column constraint: many rows may share user_id = NULL (every
-- pre-existing/orphaned row), but any real user_id may back at most one
-- builder and one seller.
ALTER TABLE builders ADD COLUMN user_id TEXT REFERENCES users(user_id);
CREATE UNIQUE INDEX idx_builders_user_id ON builders(user_id) WHERE user_id IS NOT NULL;

ALTER TABLE sellers ADD COLUMN user_id TEXT REFERENCES users(user_id);
CREATE UNIQUE INDEX idx_sellers_user_id ON sellers(user_id) WHERE user_id IS NOT NULL;
