-- #614 (sub-issue of #350): W-9/W-8BEN collection. The submitted form's
-- sensitive identifying data (SSN/EIN, foreign tax ID, name, address) is
-- encrypted at the application layer as one JSON blob (see
-- encryptTaxIdPayload/decryptTaxIdPayload in worker/index.js) before ever
-- reaching this column -- the AES-256-GCM key is a Worker secret
-- (TAX_ID_ENCRYPTION_KEY), never this database, same guarded-secret shape
-- as STRIPE_SECRET_KEY/DIDIT_API_KEY. Only the submitted form type and
-- completion timestamp are stored in plain columns, since #615's gating
-- logic and the account view (userFromRow) need those without ever
-- decrypting anything.
ALTER TABLE users ADD COLUMN tax_form_type TEXT CHECK (tax_form_type IN ('w9', 'w8ben'));
ALTER TABLE users ADD COLUMN tax_form_completed_at TEXT;
ALTER TABLE users ADD COLUMN tax_id_encrypted TEXT;
