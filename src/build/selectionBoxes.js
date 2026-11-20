// #3324 (leaf 1/7 of #3323): which selection boxes Build mode draws.
//
// A bundle (a set of placed items sharing one groupId) is one item to the
// builder, so a selection draws ONE box around each bundle, not one per
// member -- an 863-brick wall used to cost 863 outline helpers and 863 fills
// every frame, and nothing visibly changed when Group succeeded. A loose
// (ungrouped) item still draws its own box.
//
// Pure (no three.js, no DOM) so the grouping rule is unit-testable. The scene
// owns the actual boxes: for each planned entry it unions its members' world
// bounds into one Box3 and draws one helper.

export function groupIdOf(mesh) {
  return mesh?.userData?.groupId || null;
}

// meshes: the selected meshes (any iterable). Returns one entry per box to
// draw, in first-seen order: { key, members }. `key` is the groupId for a
// bundle and the mesh itself for a loose item, so the scene can keep one
// display box per key across frames.
export function planSelectionBoxes(meshes) {
  const entries = new Map();
  for (const mesh of meshes) {
    const groupId = groupIdOf(mesh);
    const key = groupId ?? mesh;
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, members: [] };
      entries.set(key, entry);
    }
    entry.members.push(mesh);
  }
  return [...entries.values()];
}

// #3996: a selection of many loose items (Select All, a marquee over a wall) drew two meshes per item,
// an outline and a fill, so a thousand items were two thousand draw calls. Past this many loose boxes
// they are drawn together instead (one instanced mesh for every fill, one line mesh for every outline);
// a bundle, and a small selection, keep their own helper and fill exactly as before.
export const LOOSE_BATCH_MIN = 8;

// Splits a plan from planSelectionBoxes into the boxes to draw together and the boxes that keep their own
// helper: a loose box has one member and no groupId.
export function splitSelectionPlan(plan, batchMin = LOOSE_BATCH_MIN) {
  const loose = plan.filter((entry) => entry.members.length === 1 && groupIdOf(entry.members[0]) === null);
  if (loose.length <= batchMin) return { batched: [], single: plan };
  const batchedKeys = new Set(loose.map((entry) => entry.key));
  return { batched: loose, single: plan.filter((entry) => !batchedKeys.has(entry.key)) };
}

// The twelve edges of an axis-aligned box as 24 vertices, written into `positions` (a Float32Array or
// array) at `offset` (in floats). Same edges THREE.Box3Helper draws. min/max: { x, y, z }.
export const BOX_EDGE_VERTICES = 24;
const EDGE_CORNERS = [
  [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 1, 0], [1, 1, 0, 0, 1, 0], [0, 1, 0, 0, 0, 0], // bottom square
  [0, 0, 1, 1, 0, 1], [1, 0, 1, 1, 1, 1], [1, 1, 1, 0, 1, 1], [0, 1, 1, 0, 0, 1], // top square
  [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1], // four uprights
];
export function writeBoxEdges(positions, offset, min, max) {
  let at = offset;
  for (const [ax, ay, az, bx, by, bz] of EDGE_CORNERS) {
    positions[at++] = ax ? max.x : min.x; positions[at++] = ay ? max.y : min.y; positions[at++] = az ? max.z : min.z;
    positions[at++] = bx ? max.x : min.x; positions[at++] = by ? max.y : min.y; positions[at++] = bz ? max.z : min.z;
  }
  return at;
}
