-- 0028 seeded five greenbelt landlets as plain, disconnected squares purely
-- to unblock frontend claim-flow testing. They never went through the real
-- generation pipeline (worker/landGenerator.js's gap-free wedge rings): no
-- real polygon, not touching each other, and — worse — claimed to be
-- 'greenbelt' without ever being enclosed by the world circle, which
-- corrupts the greenbelt/total ratio that POST /api/world/expand gates on.
-- Remove them; the frontend now bootstraps real ring-generated candidates
-- instead (see src/main.js's growTheWorld()).

DELETE FROM landlets
WHERE landlet_id IN ('greenbelt-001', 'greenbelt-002', 'greenbelt-003', 'greenbelt-004', 'greenbelt-005');
