-- Real accounts (docs/SPEC.md's login requirement, resolved: email +
-- password, the mainstream-standard baseline). Everything else in this app
-- has been a "dev-mode identity" — a free-text label anyone could type in,
-- with no password and no way to prove you're the same person twice. This
-- is the first genuinely real, unforgeable identity concept: `users` is a
-- shared, cross-device account keyed by a verified email and a real
-- password, distinct from `builders`/`sellers` (migrations/0032, 0037),
-- which stay as-is for now — linking a builder/seller profile to a real
-- user account is deliberate follow-up work, not part of this migration,
-- so this lands as new, isolated infrastructure that can't break anything
-- already working.
--
-- Password storage: PBKDF2-SHA256 via the Workers runtime's own Web
-- Crypto (see hashPassword/verifyPassword in worker/index.js) — no
-- external dependency, no native binding needed, unlike bcrypt/scrypt
-- which aren't available in this runtime without a WASM build. The
-- self-describing `pbkdf2$<iterations>$<saltHex>$<hashHex>` format stored
-- in password_hash means the iteration count can be raised later for
-- newly-set passwords without invalidating or needing to migrate
-- passwords hashed under the old count.
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  -- Always stored lowercased/trimmed (see normalizeEmail in worker/index.js)
  -- so "Ada@Example.com" and "ada@example.com" are recognized as the same
  -- account at signup, login, and password reset alike.
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  email_verified_at TEXT,
  -- A simple, dependency-free brute-force defense: no Durable Object or
  -- external rate-limiter needed, just two columns checked/updated on
  -- every login attempt (see handleLogin). Reset to 0/NULL on any
  -- successful login.
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A logged-in session, one row per active browser/device (not one row per
-- user) so logging out on a phone doesn't sign a laptop out too, and so
-- "sign out everywhere" (used on password reset — see handleResetPassword)
-- is just a DELETE WHERE user_id. token_hash stores SHA-256 of the actual
-- session token, never the raw token itself — the same defense-in-depth
-- reasoning real password storage uses: a leaked/dumped DB alone shouldn't
-- be enough to hijack a live session, only a leaked *cookie* should be.
-- The raw token lives only in the browser's HttpOnly cookie and this
-- table is looked up by re-hashing whatever token a request presents.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One-shot, expiring, hash-stored (same reasoning as sessions.token_hash)
-- tokens backing both "confirm this is really your email" and "prove you
-- own this account to change its password" — two different purposes kept
-- as two tables (rather than one generic "tokens" table with a `purpose`
-- column) so a leftover, unconsumed email-verification token can never be
-- replayed against the password-reset endpoint or vice versa.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
