CREATE INDEX idx_catalog_templates_price_id
ON catalog_templates(price_cents, template_id);
