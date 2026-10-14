-- #2043 (sub-issue of #1095, multiplayer presence): docs/SPEC.md's "Flying
-- avatars are invisible to other users" was explicitly deferred by #99
-- ("inherently multiplayer concern... skipped, not applicable single-
-- player") until live presence existed to apply it to. #1095's own
-- report/poll pipeline is real now, but never carried whether the
-- reporting builder is currently flying -- this column is that one bit.
-- NOT NULL DEFAULT 0 so every existing/future row has a concrete value to
-- filter on (never NULL-means-unknown ambiguity for the GET endpoint's own
-- visibility decision).
ALTER TABLE avatar_presence ADD COLUMN flying INTEGER NOT NULL DEFAULT 0;
