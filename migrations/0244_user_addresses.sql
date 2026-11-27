-- #4598 (Shipping 1/8, part of #4394): the addresses a person ships to, kept on the account. Personal data of a new
-- kind: read only by the person it belongs to (and, in later pieces, by the buyer and the seller of the one order an
-- address was copied onto). Keyed on the account (user_id), as plain TEXT with no foreign key, like user_blocks (0188):
-- the record belongs to the account, not to a builder profile that can be reset. Account deletion removes the rows
-- explicitly (cascadeDeleteAccount); the data export lists them (exportCommunicationData).
-- country is an ISO 3166-1 alpha-2 code. At most one row per account is marked default (is_default = 1): the handler
-- keeps that true; the partial unique index makes the database refuse a second one.
CREATE TABLE IF NOT EXISTS user_addresses (
  address_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  region TEXT,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL,
  phone TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_addresses_one_default ON user_addresses(user_id) WHERE is_default = 1;
