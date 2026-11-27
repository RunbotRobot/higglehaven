-- #4602 (Shipping 5/8, part of #4394): a person's shipping destination for the "dim what cannot ship to me" filter.
-- shipping_country is the country (ISO 3166-1 alpha-2) a person chose in Settings for when they keep no address yet;
-- with an address, the country of the default one is used instead and this is ignored. dim_unshippable is the filter
-- switch (1 = on); NULL and 0 both mean off. Neither is ever shown to anyone but the account itself.
ALTER TABLE users ADD COLUMN shipping_country TEXT;
ALTER TABLE users ADD COLUMN dim_unshippable INTEGER;
