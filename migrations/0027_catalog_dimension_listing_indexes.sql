CREATE INDEX idx_catalog_templates_width_name
ON catalog_templates(width_m, name, template_id);

CREATE INDEX idx_catalog_templates_depth_name
ON catalog_templates(depth_m, name, template_id);

CREATE INDEX idx_catalog_templates_height_name
ON catalog_templates(height_m, name, template_id);
