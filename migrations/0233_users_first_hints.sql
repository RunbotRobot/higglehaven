-- #3657: the first-visit hints (walk, look, fly) are remembered by the account, so
-- signing in on a new device does not replay them for someone who has done them.
-- NULL or 0 means not yet; 1 means the person has been through all three. Only ever
-- set to 1, never cleared. Nothing sensitive: one bit, the same shape as
-- users.loading_tips_off (0231).
ALTER TABLE users ADD COLUMN first_hints_done INTEGER;
