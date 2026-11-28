-- #4636: when an order's address copy was cleared (the retention sweep, or a buyer's account deletion of a refunded
-- order), so the seller's and the buyer's views can say "Address removed on <date>" instead of only that it is gone.
-- Empty for an order whose address is still held, and for one cleared before this column existed.
ALTER TABLE purchases ADD COLUMN shipping_address_cleared_at TEXT;
