-- #3057: a seller whose suspension escalated into a permanent account closure
-- (escalateExpiredSuspensions -> cascadeDeleteAccount) has their `sellers` row
-- hard-deleted, and every "suspended seller" predicate (catalog browse hide,
-- placement block, published-version filter, purchase block) reaches the
-- seller through that row. Once it was gone they all went false at once and
-- the closed seller's products reappeared for sale. This table remembers the
-- closed seller_id so those predicates keep matching after the sellers row is
-- gone. Written only by the suspension-ladder closure (never by an ordinary
-- self-deletion), and removed again if that closure's cascade fails and is
-- retried while the seller still exists.
CREATE TABLE IF NOT EXISTS closed_sellers (
  seller_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  closed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
