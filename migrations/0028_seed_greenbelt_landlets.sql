-- The only landlet seeded by 0001_initial.sql (starter-landlet) is already
-- claimed, so a fresh dev backend has zero landlets available to claim —
-- the frontend's claim flow (see src/main.js's resolveLandletId) always hit
-- "nothing ready yet" until an admin manually created some via the API.
-- Seed a handful of greenbelt (claimable, unowned) landlets so the claim
-- flow is usable out of the box, without pretending they went through the
-- real procedural-generation pipeline (generated_at/claimable_at stay NULL,
-- same as any other placeholder row).

INSERT OR IGNORE INTO landlets (landlet_id, name, area_m2, center_x_m, center_y_m, status)
VALUES
  ('greenbelt-001', 'Greenbelt landlet 1', 1000, 40, 0, 'greenbelt'),
  ('greenbelt-002', 'Greenbelt landlet 2', 1000, -40, 0, 'greenbelt'),
  ('greenbelt-003', 'Greenbelt landlet 3', 1000, 0, 40, 'greenbelt'),
  ('greenbelt-004', 'Greenbelt landlet 4', 1000, 0, -40, 'greenbelt'),
  ('greenbelt-005', 'Greenbelt landlet 5', 1000, 40, 40, 'greenbelt');
