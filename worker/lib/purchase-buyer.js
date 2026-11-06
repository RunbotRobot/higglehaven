// #3214 (follow-up to #3195): who counts as a purchase's buyer when they act
// on it (leave/edit/delete seller feedback, raise a dispute).
//
// A buyer is a person, so the standing decision "Anything about a person as a
// person keys on the account (user_id)" applies: purchases.buyer_user_id
// (migration 0194) outlives a builder-profile reset, while buyer_builder_id is
// ON DELETE SET NULL (migration 0099) and goes NULL on one. Authorising by
// buyer_builder_id alone left a buyer whose profile was reset able to *see* a
// purchase but not act on it -- the dispute path being the sharp edge.
//
// Rule: the purchase's buyer_user_id when it has one; for a purchase that has
// none (it predates the #3195 backfill and its builder was already gone, or
// the buyer had no resolvable account) fall back to the old buyer_builder_id
// match, so nothing that worked before stops working.

// The session builder row carries both ids: builder_id and user_id.
export function sessionIsPurchaseBuyer(purchase, sessionBuilder) {
  if (purchase.buyer_user_id) return purchase.buyer_user_id === sessionBuilder.user_id;
  return !!purchase.buyer_builder_id && purchase.buyer_builder_id === sessionBuilder.builder_id;
}

// SQL: the buyer's user_id for a purchases row aliased `alias`, however it is
// recorded (the account directly, or via a builder row that still exists).
export function purchaseBuyerUserIdSql(alias = 'p') {
  return `COALESCE(${alias}.buyer_user_id, (SELECT b.user_id FROM builders b WHERE b.builder_id = ${alias}.buyer_builder_id))`;
}

// SQL condition: this purchases row (unaliased `purchases`) belongs to the
// given buyer. Binds two placeholders, in order: user_id, builder_id.
export const BUYER_PURCHASES_MATCH_SQL = '(buyer_user_id = ? OR (buyer_user_id IS NULL AND buyer_builder_id = ?))';
