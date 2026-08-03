CREATE INDEX idx_catalog_templates_price_name
ON catalog_templates(price_cents, name, template_id);
