-- Support stable catalog pagination both globally and within a category.

CREATE INDEX IF NOT EXISTS idx_catalog_templates_name
ON catalog_templates(name, template_id);

CREATE INDEX IF NOT EXISTS idx_catalog_templates_category_name
ON catalog_templates(category, name, template_id);
