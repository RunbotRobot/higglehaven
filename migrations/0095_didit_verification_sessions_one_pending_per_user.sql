-- #1039: handleDiditVerificationSession read the user's latest session,
-- then only created+inserted a new one if none was found pending -- with
-- no locking or uniqueness guard between that read and the insert. Two
-- concurrent requests (a double-click on "Verify ID", or two open tabs)
-- could both observe no pending session, both make the real, billed call
-- to Didit's session-create API (~$0.33/verification beyond the free
-- tier, per #589's own research), and both get inserted as separate rows
-- -- the "losing" session simply orphaned, never reused, but still
-- charged for.
--
-- Same check-then-insert race class #117 already closed for one-review-
-- per-purchaser (migrations/0059's own idx_product_reviews_one_per_author).
-- worker/index.js's reserveDiditSession now folds the check into an
-- atomic INSERT ... WHERE NOT EXISTS before ever calling Didit, so the
-- loser of the race never places the real outbound call at all -- this
-- unique partial index is the same defense-in-depth backstop
-- idx_product_reviews_one_per_author provides alongside its own
-- WHERE NOT EXISTS guard.
CREATE UNIQUE INDEX idx_didit_verification_sessions_one_pending_per_user
  ON didit_verification_sessions(user_id) WHERE processed_at IS NULL;
