-- #4390 (docs/SPEC.md §2: standing still too long shows AFK): whether the reporting
-- person has stepped away. One bit, same shape as `flying` (migrations/0144):
-- NOT NULL DEFAULT 0 so every row has a concrete value and an older client that
-- never reports it simply reads as present. Where someone is looking is NOT
-- carried (the engaged-item half of the issue waits on a privacy call).
ALTER TABLE avatar_presence ADD COLUMN afk INTEGER NOT NULL DEFAULT 0;
