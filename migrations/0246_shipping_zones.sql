-- #4601 (part of #4394, shipping): `metadata.shippingZones` (shared/shipping-zones.js) replaces the single
-- `metadata.domesticOnly` flag, so a product keeps one model of where it ships. A product that was restricted
-- to the United States keeps exactly that (`["us"]`); a product with the flag false or absent already shipped
-- everywhere, which is what an absent `shippingZones` means, so the stale `false` is only dropped.
UPDATE catalog_templates
SET metadata_json = json_set(json_remove(metadata_json, '$.domesticOnly'), '$.shippingZones', json('["us"]'))
WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.domesticOnly') = 1;

UPDATE catalog_templates
SET metadata_json = json_remove(metadata_json, '$.domesticOnly')
WHERE json_valid(metadata_json) AND json_type(metadata_json, '$.domesticOnly') IS NOT NULL;
