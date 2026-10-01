-- #1072 (owner decision via Control Room, 2026-10-01): "one card, one
-- account, permanently. No household/shared-card exception." PR #1073
-- already closed the base spoofing hole (handleConfirmCard now derives the
-- PaymentMethod from the caller's own SetupIntent instead of trusting a
-- client-supplied id) -- this is the separate reuse-tracking piece the
-- owner's direction explicitly called out as still needed: a PaymentMethod
-- id alone isn't enough, since a caller can generate a fresh PaymentMethod/
-- SetupIntent from the exact same physical card. Stripe's own card
-- fingerprint is stable per physical card across different PaymentMethod
-- objects, so recording it against whichever account first confirms it
-- (and rejecting a later confirm-card attempt under a different account)
-- is what actually enforces "permanently," not just "this one session."
--
-- A dedicated table, not a column on users, for the same "claim it
-- atomically via INSERT OR IGNORE + re-read" idiom this file already uses
-- for builders/sellers/owned_avatars (see worker/index.js's own
-- getOrCreateBuilderForUser comment) -- a UNIQUE column would let two
-- concurrent confirm-card calls for the same fingerprint both pass a
-- SELECT-then-UPDATE check before either write commits.
CREATE TABLE IF NOT EXISTS card_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
