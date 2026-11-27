-- #4600 (shipping 3/8, part of #4394): a seller can say who carried an order and under what number when they mark it
-- shipped, and correct it afterwards; the buyer reads both on their order. Both are optional free text, NULL for an
-- order not yet shipped, for one shipped without them, and for every order made before this column existed.
ALTER TABLE purchases ADD COLUMN shipping_carrier TEXT;
ALTER TABLE purchases ADD COLUMN tracking_number TEXT;
