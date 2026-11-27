-- #4611 (Basket 1/7, part of #4604, under #4394): the lines of a person's basket, kept on the account. Keyed on the
-- account (user_id) as plain TEXT with no foreign key, like user_addresses (0244) and user_blocks (0188): a basket is
-- a fact about a person, not about a builder profile that can be reset. A line is a placed item (instance_id), not a
-- product, because the builder commission follows the lándlet the item stands on; there is one line per item and
-- quantity says how many. The price is never stored on a line: it is read when the basket is shown and when it is paid.
-- Account deletion removes the rows explicitly (cascadeDeleteAccount); the data export lists them.
CREATE TABLE IF NOT EXISTS basket_lines (
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, instance_id)
);
