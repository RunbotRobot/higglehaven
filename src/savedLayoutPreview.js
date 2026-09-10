// #635 (sub-issue of #631): pure ground-sizing math for the faux-layout
// preview — split out from src/main.js the same way sellerShowcase.js's own
// grid math is, per this project's convention for genuinely dependency-free
// frontend modules (see vitest.config.js's own comment on src/**/*.test.js).
//
// Unlike sellerShowcase's own grid-repacking (#540), a saved layout's own
// instances keep their true original x/y offsets exactly as saved — per
// #631's own scoping ("a faux lánd that renders their saved lánd so that it
// all fits exactly right"). This only needs to size a ground plane generous
// enough to contain every saved instance at its real position, not decide
// where each one goes the way sellerShowcase's grid-packing does.

// Clearance added around the outermost saved instance's own position in
// each direction, so nothing sits flush against the ground plane's edge.
export const SAVED_LAYOUT_PREVIEW_MARGIN_M = 3;

// A saved layout can hold as few as one instance (#633 never creates an
// empty record — see its own "skip when nothing was swept" guard) — floor
// either ground dimension at this so a single/tightly-clustered instance
// still gets a real, sensibly-sized plane to stand on rather than a
// sliver barely larger than the margin alone.
export const SAVED_LAYOUT_PREVIEW_MIN_GROUND_M = 8;

// Bounding box (plus margin) over every instance's saved x/y position,
// returned as a centered width/depth plus the offset needed to re-center
// that box at the world origin — the ground plane and every instance mesh
// both shift by (-centerX, -centerY) so the preview always renders around
// (0, 0) regardless of where the original landlet actually sat in the
// world, the same "render it as its own self-contained little world"
// property sellerShowcase's own faux ground already has.
//
// centerZ does the same job for height: every instance here was swept out
// of one removed level (#633), so its saved z is that level's real-world
// elevation — often 10s of meters up, nowhere near this preview's own
// ground plane at z=0. Recentering z the same way x/y already are (rather
// than leaving instances at their original height) puts them right on the
// preview's ground instead of floating far outside the camera's frame.
export function computeSavedLayoutGround(instances) {
  const xs = instances.map((i) => i.x);
  const ys = instances.map((i) => i.y);
  const zs = instances.map((i) => i.z || 0);
  const minX = Math.min(...xs) - SAVED_LAYOUT_PREVIEW_MARGIN_M;
  const maxX = Math.max(...xs) + SAVED_LAYOUT_PREVIEW_MARGIN_M;
  const minY = Math.min(...ys) - SAVED_LAYOUT_PREVIEW_MARGIN_M;
  const maxY = Math.max(...ys) + SAVED_LAYOUT_PREVIEW_MARGIN_M;
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const width = Math.max(maxX - minX, SAVED_LAYOUT_PREVIEW_MIN_GROUND_M);
  const depth = Math.max(maxY - minY, SAVED_LAYOUT_PREVIEW_MIN_GROUND_M);
  return {
    width, depth, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, centerZ: (minZ + maxZ) / 2,
  };
}

// Axis-aligned rect-contains-point test for the drag-rectangle marquee
// (#635's own v1 selection interaction, proposed in place of a literal
// freehand circle per the scoping discussion on #631 — a closer-to-literal
// lasso/circle select can be a later refinement, not a v1 blocker).
// `rect` and `point` are both in the same screen-pixel space; `rect` is
// normalized here so it works regardless of which corner the drag started
// from (dragging up-left produces a "rect" with x1>x2/y1>y2 otherwise).
export function pointInDragRect(point, rect) {
  const minX = Math.min(rect.x1, rect.x2);
  const maxX = Math.max(rect.x1, rect.x2);
  const minY = Math.min(rect.y1, rect.y2);
  const maxY = Math.max(rect.y1, rect.y2);
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}
