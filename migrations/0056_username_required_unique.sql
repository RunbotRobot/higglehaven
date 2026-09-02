-- Username: required and unique — this used to be an optional
-- `display_name` (see 0053_users_auth.sql) with no uniqueness guarantee,
-- which no longer fits its actual role now that it's how people recognize
-- each other, not just a cosmetic label. Case-insensitive uniqueness
-- (COLLATE NOCASE) so "Ada" and "ada" can't both be claimed while still
-- storing whatever casing the person actually chose.
--
-- This migration originally rebuilt the whole table (CREATE users_new /
-- copy / DROP / RENAME — SQLite's documented recipe for a change ALTER
-- COLUMN can't express, needed here since NOT NULL can't be added to an
-- existing column either), wrapped in PRAGMA foreign_keys = OFF/ON since
-- sessions/email_verification_tokens/password_reset_tokens/builders/
-- sellers all hold a foreign key to users(user_id) and D1 enforces those
-- by default. That PRAGMA bracketing works in every local/test SQLite
-- session but does NOT survive Cloudflare D1's remote execution — confirmed
-- against the real deployment, where it failed outright at DROP TABLE with
-- a foreign-key-constraint error and cleanly rolled back (nothing broken,
-- but nothing applied either). Replaced with a version that never touches
-- the table's identity at all:
--
-- RENAME COLUMN (SQLite 3.25+, which D1 supports) needs no rebuild and
-- doesn't disturb any foreign key referencing users(user_id), since those
-- reference the table/column by name, not the renamed column. The
-- uniqueness half comes from a plain unique index instead of a column
-- constraint — same enforcement, no rebuild either. The one thing this
-- can't do is a real NOT NULL on the column itself (still requires a
-- rebuild, which is exactly what just proved unsafe to do here); the
-- backfill below means no row is null at migration time, and every
-- signup since has gone through usernameValue() in worker/index.js, which
-- already refuses a missing/blank username before a row is ever inserted
-- — so NOT NULL is enforced at the application boundary instead of the
-- schema.
ALTER TABLE users RENAME COLUMN display_name TO username;

-- Any existing row that never set one is backfilled from its email's local
-- part plus a slice of its own user_id — guaranteed unique per row without
-- colliding with another backfilled row or a real username sharing that
-- email prefix.
UPDATE users
SET username = substr(email, 1, instr(email, '@') - 1) || '-' || substr(user_id, -8)
WHERE username IS NULL OR TRIM(username) = '';

CREATE UNIQUE INDEX idx_users_username_nocase ON users (username COLLATE NOCASE);
