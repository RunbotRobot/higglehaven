-- #4422 (owner chose B, 2026-11-27): a counterfeit listing's buyers whose seller was already paid out are repaid from
-- higglehaven's own balance, on the owner's separate confirmation. This column marks such a purchase and records what
-- the platform paid (99% of the order, in cents), so the amount can be totalled later and a purchase is never repaid
-- twice. NULL for every ordinary purchase. The seller's earnings stay as paid, so reports that count a seller's gross
-- (the 1099-K figures) keep counting a purchase with this set, although refunded_at is set on it too.
ALTER TABLE purchases ADD COLUMN platform_refund_cents INTEGER;
