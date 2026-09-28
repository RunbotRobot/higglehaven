-- #1014: every other `REFERENCES users(user_id)` FK in this schema declares
-- an explicit ON DELETE behavior (sessions/email_verification_tokens/
-- password_reset_tokens via 0053, tax_1099_forms via 0081,
-- admin_action_log.admin_user_id via 0087) except sellers.user_id,
-- builders.user_id, and didit_verification_sessions.user_id (all added with
-- no ON DELETE clause at all, i.e. SQLite/D1's default RESTRICT). No
-- DELETE /api/users/:id (or any account-deletion feature) exists yet, so
-- this is a latent inconsistency rather than a live bug -- but worth
-- closing now, before an account-deletion feature has to discover it the
-- hard way via a confusing constraint-violation error.
--
-- sellers.user_id -> ON DELETE SET NULL: an orphaned-but-still-referenced
-- seller profile is the same "keep the record, drop the live reference"
-- shape migrations/0062 and 0086 already chose for purchases.builder_id
-- and higgles_redemptions.builder_id.
--
-- didit_verification_sessions.user_id -> ON DELETE CASCADE: a verification-
-- session log has no reason to outlive the account it verified, matching
-- sessions/tax_1099_forms's own CASCADE choice.
--
-- Rebuild via SQLite's documented CREATE-new/copy/DROP-old/RENAME recipe
-- (migrations/0062 and 0086's own precedent) -- safe for both tables since
-- nothing holds a foreign key into either sellers or
-- didit_verification_sessions (confirmed: no other migration declares
-- `REFERENCES sellers(...)` or `REFERENCES didit_verification_sessions(...)`
-- anywhere in this directory).
--
-- builders.user_id is deliberately NOT included in this migration, despite
-- #1014 suggesting the same SET NULL treatment for it. Unlike sellers,
-- builders is the parent side of many ON DELETE CASCADE/SET NULL foreign
-- keys (notifications, bundles, auctions x2, friendships x2, land_cap,
-- saved_level_layouts, avatar_ownership all CASCADE; purchases and
-- higgles_redemptions SET NULL). Per SQLite's own documented DROP TABLE
-- semantics, dropping a table performs an implicit "DELETE FROM" on it
-- first when foreign keys are enabled, firing every CASCADE/SET NULL
-- action those child tables declare -- confirmed empirically against this
-- project's real D1/workerd test engine: rebuilding builders the same way
-- as sellers here ran DROP TABLE builders with *no error at all*, while
-- silently cascade-deleting every row in a dependent table (notifications,
-- in the probe). That's strictly worse than migration 0056's own
-- documented builders/sellers/users rebuild failure (0056 at least failed
-- loudly and rolled back cleanly on real D1) -- here the migration would
-- appear to succeed while quietly destroying real notifications/bundles/
-- auctions/friendships/land_cap/saved-layout/avatar-ownership rows for
-- every existing builder. Safely closing builders.user_id's own gap needs
-- either rebuilding every one of those dependent tables in the same pass
-- (a much larger, higher-risk migration) or a different technique
-- entirely -- left as a separate, correctly-scoped follow-up rather than
-- attempted here. See issue comment on #1014.
CREATE TABLE sellers_new (
  seller_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  stripe_account_id TEXT,
  stripe_onboarding_status TEXT NOT NULL DEFAULT 'not_started',
  stripe_requirements_due TEXT,
  stripe_updated_at TEXT
);

INSERT INTO sellers_new
  SELECT seller_id, label, created_at, updated_at, user_id, stripe_account_id,
         stripe_onboarding_status, stripe_requirements_due, stripe_updated_at
  FROM sellers;

DROP TABLE sellers;
ALTER TABLE sellers_new RENAME TO sellers;

CREATE UNIQUE INDEX idx_sellers_user_id ON sellers(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE didit_verification_sessions_new (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT,
  url TEXT
);

INSERT INTO didit_verification_sessions_new
  SELECT session_id, user_id, status, created_at, processed_at, url
  FROM didit_verification_sessions;

DROP TABLE didit_verification_sessions;
ALTER TABLE didit_verification_sessions_new RENAME TO didit_verification_sessions;

CREATE INDEX idx_didit_verification_sessions_user_id ON didit_verification_sessions(user_id, created_at);
