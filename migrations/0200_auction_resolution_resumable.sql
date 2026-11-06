-- #968: resolveAuction flips an auction to status='ended' as a standalone
-- concurrency guard, then runs a multi-step candidate loop (debit a bidder,
-- attempt the land transfer, refund on failure) before it records any
-- outcome. An interruption in between left the row 'ended' with no
-- winning_bid_id -- indistinguishable from a legitimately resolved
-- no-winner auction -- and nothing ever revisited it.
--
-- Design (owner delegated the shape to engineering judgment, #968): a
-- per-bid marker plus two auction-level markers, so a resumed resolution
-- can never debit the same bidder twice and never notifies twice.
--   * auctions.resolving_at: set by the guard flip. Together with a NULL
--     resolution_completed_at and NULL winning_bid_id it identifies
--     "resolution started but no outcome recorded". Auctions ended by other
--     paths (#809's sibling-auction end, legacy rows) never carry it, so
--     the resume sweep can't mistake them for stuck ones.
--   * auctions.resolution_completed_at: set atomically with the no-winner
--     outcome batch (the winner path already has winning_bid_id +
--     the #875 settlement marker).
--   * auction_bids.resolution / resolution_token: 'debited' (this bid's
--     amount was taken from the bidder, token ties the debit statement to
--     the exact marker write) or 'skipped' (could not be honored, or
--     refunded after a failed transfer).
ALTER TABLE auctions ADD COLUMN resolving_at TEXT;
ALTER TABLE auctions ADD COLUMN resolution_completed_at TEXT;
ALTER TABLE auction_bids ADD COLUMN resolution TEXT CHECK (resolution IS NULL OR resolution IN ('debited', 'skipped'));
ALTER TABLE auction_bids ADD COLUMN resolution_token TEXT;

CREATE INDEX IF NOT EXISTS idx_auctions_resolution_pending
  ON auctions(resolving_at) WHERE status = 'ended' AND winning_bid_id IS NULL AND resolution_completed_at IS NULL AND resolving_at IS NOT NULL;
