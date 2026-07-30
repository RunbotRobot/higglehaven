-- Products could previously only spin around Z (yaw). Real uploaded scans
-- aren't guaranteed to have been captured perfectly level/upright (a
-- RealityScan brick scan came out tilted), so the rotate gizmo now allows
-- all three axes — which means all three need to persist, not just yaw.
-- Existing rows default to 0 on both new columns, correctly meaning "no
-- tilt" for every instance placed before this existed.

ALTER TABLE placed_instances ADD COLUMN rotation_x_rad REAL NOT NULL DEFAULT 0;
ALTER TABLE placed_instances ADD COLUMN rotation_y_rad REAL NOT NULL DEFAULT 0;
