-- #1109 (owner decision, 2026-10-27, via Control Room/GitHub conversation):
-- velocity-based limits on commission cash outs, to close the chargeback
-- fraud gap a plain refund's own REFUND_PAYOUT_RATE haircut (migrations/
-- 0052) can't reach -- a chargeback is reversed at Stripe/the card
-- network's own amount, not this app's, so "fake sale -> cash out the
-- builder's commission -> reverse the charge via chargeback" was still
-- open even with that protection in place.
--
-- Mechanism: credit-time cap-and-escrow. worker/lib/commission-caps.js's
-- commissionCapCentsForSale caps how much of a single sale's commission
-- can be credited to higgles_balance_cents/higgles_earnings_events
-- immediately; whatever a sale's builder_share_cents exceeds that cap
-- lands here instead, held rather than forfeited -- the owner's own
-- discussed 1-4 week hold is this table's release_at, not a separate
-- mechanism. worker/index.js's releaseDueCommissionHolds cron sweep
-- credits a hold once release_at passes, unless the underlying purchase
-- was refunded/charged-back in the meantime (purchases.refunded_at alone
-- covers both -- a chargeback webhook sets the same column a seller-
-- initiated refund does), in which case worker/lib/purchase-lifecycle.js's
-- clawBackPurchaseCommission revokes it instead of ever crediting it.
--
-- One row per capped sale (an uncapped sale never gets one at all) --
-- purchase_id/builder_id both cascade on delete the same way every other
-- builder-keyed table in this codebase does (voice_signaling_messages,
-- migrations/0157, is the most recent precedent); purchases rows are
-- never actually deleted by any code path today, but the FK still needs
-- a real ON DELETE action to be well-formed.
CREATE TABLE commission_holds (
  hold_id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(purchase_id) ON DELETE CASCADE,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  release_at TEXT NOT NULL,
  released_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- releaseDueCommissionHolds's own sweep filters on exactly these three
-- columns (release_at <= now AND released_at IS NULL AND revoked_at IS
-- NULL) -- same leading-filter-columns-first indexing convention as
-- idx_voice_signaling_messages_recipient (migrations/0157).
CREATE INDEX idx_commission_holds_release ON commission_holds(released_at, revoked_at, release_at);

-- clawBackPurchaseCommission's own lookup, by purchase_id, of any still-
-- active hold to revoke on refund/chargeback.
CREATE INDEX idx_commission_holds_purchase ON commission_holds(purchase_id);
