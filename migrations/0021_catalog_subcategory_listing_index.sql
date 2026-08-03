CREATE INDEX idx_catalog_templates_category_subcategory_name
ON catalog_templates(category, subcategory, name, template_id);

CREATE INDEX idx_catalog_templates_subcategory_name
ON catalog_templates(subcategory, name, template_id);
