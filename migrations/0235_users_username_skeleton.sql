-- #4136: the folded form of a username (case, accents, spacing and look-alike letters folded; see
-- worker/lib/username-rules.js), compared when someone picks a name so nobody can register one that reads as an
-- existing person's or as "Juniper". It is computed in the Worker, which SQL cannot do, so existing rows start NULL
-- and are filled in a few at a time the next time a name is checked (ensureUsernameSkeletons). Not a unique index:
-- two existing names that fold alike must be reported, not made to fail a migration, and uniqueness for new and
-- changed names is enforced by the guarded INSERT/UPDATE that sets it.
ALTER TABLE users ADD COLUMN username_skeleton TEXT;
CREATE INDEX idx_users_username_skeleton ON users (username_skeleton);
