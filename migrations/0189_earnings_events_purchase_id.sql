-- #836: a refund never reversed the higgles_earnings_events row its sale
-- created, so a buy+refund cycle still counted toward the trailing-window
-- land-cap recomputation. purchase_id lets the refund clawback find and
-- remove exactly the rows that sale (or its released commission hold)
-- produced. Nullable: rows written before this migration (and admin
-- grants / auction settlements, which have no purchase) have none, and are
-- left alone -- the earlier event ids are random, so no link is derivable.
ALTER TABLE higgles_earnings_events ADD COLUMN purchase_id TEXT;
CREATE INDEX idx_higgles_earnings_events_purchase_id ON higgles_earnings_events(purchase_id) WHERE purchase_id IS NOT NULL;
