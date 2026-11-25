-- #4175: a look-only admin role. The owner switches it on for one account (from the admin dashboard, built
-- under the same issue) so a fleet session can look at the owner's tools without being able to change
-- anything. It is a second flag, never is_admin: every admin check that reads is_admin refuses a viewer
-- without being told about it (default deny), and only the read routes that opt in through
-- requireAdminOrViewer (worker/lib/auth.js) let one in, and only for GET and HEAD.
ALTER TABLE users ADD COLUMN is_admin_viewer INTEGER NOT NULL DEFAULT 0;
