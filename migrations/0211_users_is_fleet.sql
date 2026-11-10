-- #3429 (part of #3428): fleet accounts. A Claude Code session signs in to
-- the live site as its own account (POST /api/auth/fleet-login, only with
-- the fleet key) so it can see and use the app the way a person does. The
-- flag keeps those accounts out of everything that measures or moderates
-- real people: their flags weigh nothing, they cannot file reports or
-- ratings, and they cannot spend real money.
ALTER TABLE users ADD COLUMN is_fleet INTEGER NOT NULL DEFAULT 0;

-- A fleet account must never hold admin, whichever code path tries to grant
-- it (admin-bootstrap, grant-admin, a direct write). Enforced here rather
-- than only in the handlers so a future grant path cannot forget it.
CREATE TRIGGER users_fleet_never_admin_insert
BEFORE INSERT ON users
WHEN NEW.is_fleet = 1 AND NEW.is_admin = 1
BEGIN
  SELECT RAISE(ABORT, 'A fleet account can never be an admin');
END;

CREATE TRIGGER users_fleet_never_admin_update
BEFORE UPDATE ON users
WHEN NEW.is_fleet = 1 AND NEW.is_admin = 1
BEGIN
  SELECT RAISE(ABORT, 'A fleet account can never be an admin');
END;
