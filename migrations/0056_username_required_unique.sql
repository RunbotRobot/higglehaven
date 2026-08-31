-- Username: required and unique — this used to be an optional
-- `display_name` (see 0053_users_auth.sql) with no uniqueness guarantee,
-- which no longer fits its actual role now that it's how people recognize
-- each other, not just a cosmetic label. Case-insensitive uniqueness
-- (COLLATE NOCASE) so "Ada" and "ada" can't both be claimed while still
-- storing whatever casing the person actually chose.
--
-- SQLite has no ALTER COLUMN, so this rebuilds the table. Any existing row
-- that never set a display_name is backfilled from its email's local part
-- plus a slice of its own user_id — guaranteed unique per row without
-- colliding with another backfilled row or a real username sharing that
-- email prefix.
--
-- sessions/email_verification_tokens/password_reset_tokens/builders/
-- sellers all hold a foreign key to users(user_id) — D1 enforces foreign
-- keys by default, and dropping a table other tables reference needs that
-- off for the rebuild, per SQLite's own documented recipe for this exact
-- situation. Re-enabled once the new table is in place under the same
-- name and primary key, so those references are exactly as valid as
-- before.
PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified_at TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO users_new (user_id, email, password_hash, username, email_verified_at, failed_login_attempts, locked_until, is_admin, created_at, updated_at)
SELECT
  user_id,
  email,
  password_hash,
  COALESCE(NULLIF(TRIM(display_name), ''), substr(email, 1, instr(email, '@') - 1) || '-' || substr(user_id, -8)),
  email_verified_at,
  failed_login_attempts,
  locked_until,
  is_admin,
  created_at,
  updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

PRAGMA foreign_keys = ON;
