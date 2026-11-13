-- #3517: the e-filing vendor's v2.0.0 API creates a submission and transmits it
-- in two separate calls. The id Create returns is stored here the moment it
-- answers, before Transmit is tried, so a retry after a failed or interrupted
-- Transmit sends that submission instead of creating a second one. Null until a
-- submission has been created. filing_reference still holds the id once the form
-- is actually filed, as before.
ALTER TABLE tax_1099_forms ADD COLUMN efiling_submission_id TEXT;
