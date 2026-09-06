-- Issue #200 (owner decision, via the control room): one real account per
-- email, closing the "+tag"/dot-variant sybil vector `normalizeEmail`
-- (worker/index.js) previously left open (it only lowercased). The
-- literal, lowercased `email` column itself is left untouched — every
-- already-registered account (including the owner's own +test1/+test2
-- accounts, deliberately created to test this exact gap) keeps logging in
-- and resetting its password exactly as before, matched by the same
-- literal value it always has been. `email_canonical` is a second,
-- separate signal, checked only at signup time (see handleSignup) to
-- reject a *new* registration that collides with an existing account
-- once "+tags" are stripped and (Gmail only) dots are folded — see
-- canonicalizeEmail's own comment. Deliberately no UNIQUE constraint
-- here and no backfill of existing rows: pre-existing +tag variants
-- (the owner's own test accounts among them) already coexist today and
-- must keep coexisting unmerged; only NEW signups going forward are
-- blocked from adding to that count. A plain index keeps the signup
-- check's WHERE email_canonical = ? lookup fast without pretending old
-- data was ever deduplicated.
ALTER TABLE users ADD COLUMN email_canonical TEXT;

CREATE INDEX IF NOT EXISTS idx_users_email_canonical ON users(email_canonical);
