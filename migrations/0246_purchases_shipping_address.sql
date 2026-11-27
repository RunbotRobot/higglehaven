-- #4599 (shipping, 2/8; owner decision 2026-11-27, option B): an order for a shipped product keeps its own copy of the
-- address it was bought for, as JSON ({name, line1, line2, city, region, postalCode, country}), written when the order is
-- made and never changed afterwards: "An order is its own record". A later edit or removal of a saved address never
-- reaches an order. NULL for a digital good and for every order made before addresses were asked for.
--
-- Personal data of a new kind: read only by the buyer (My purchases) and, in a later piece, by the seller of that one
-- order. No search, no analytics, no self-dealing signal reads it.
ALTER TABLE purchases ADD COLUMN shipping_address_json TEXT;
