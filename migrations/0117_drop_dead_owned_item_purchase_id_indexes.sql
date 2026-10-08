-- #1529: idx_owned_avatars_purchase_id (migrations/0090, #1016) and
-- idx_owned_animations_purchase_id (migrations/0106) are both dead weight.
-- 0090's own comment explains why it was added: the refund handler used to
-- run `SELECT ... FROM owned_avatars WHERE purchase_id = ?` on every refund.
-- migrations/0094_owned_avatar_purchases.sql (#1033) replaced that query
-- shape entirely with a dedicated owned_avatar_purchases side table (PK on
-- purchase_id, so no secondary index needed there either) -- the current
-- revocation code (clawBackPurchaseCommission, worker/index.js) looks up
-- that side table by purchase_id, then deletes from owned_avatars/
-- owned_animations filtered by (builder_id, template_id) only. Confirmed by
-- grep: nothing left anywhere in the app filters owned_avatars or
-- owned_animations by purchase_id. Same "dropping them rather than leaving
-- dead weight on every write" reasoning as migrations/0112 and 0113 already
-- applied to friendships/bundles/saved_layouts, just for a flat-out-unused
-- index rather than a leftmost-prefix-redundant one.
DROP INDEX IF EXISTS idx_owned_avatars_purchase_id;
DROP INDEX IF EXISTS idx_owned_animations_purchase_id;
