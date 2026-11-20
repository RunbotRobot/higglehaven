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

// #3996: the selection boxes of loose items are drawn as two batches (one line mesh for every
// box's edges, one instanced mesh for every box's fill) instead of two objects per item, so a
// selection of a thousand items costs two draw calls, not two thousand. This is the one rule the
// line batch needs: the 12 edges of an axis-aligned box as 24 vertices (xyz each), written into a
// shared array. Pure, so it is unit-tested without three.js.
export const BOX_EDGE_VERTICES = 24;
export const BOX_EDGE_FLOATS = BOX_EDGE_VERTICES * 3;

// The 12 edges as corner pairs; corner i has x at max when bit 0 is set, y when bit 1, z when bit 2.
const EDGE_PAIRS = [];
for (let axis = 0; axis < 3; axis += 1) {
  const others = [0, 1, 2].filter((a) => a !== axis);
  for (let combo = 0; combo < 4; combo += 1) {
    const base = ((combo & 1) << others[0]) | (((combo >> 1) & 1) << others[1]);
    EDGE_PAIRS.push([base, base | (1 << axis)]);
  }
}

export function writeBoxEdges(out, offset, minX, minY, minZ, maxX, maxY, maxZ) {
  let at = offset;
  for (const [a, b] of EDGE_PAIRS) {
    for (const corner of [a, b]) {
      out[at] = corner & 1 ? maxX : minX;
      out[at + 1] = corner & 2 ? maxY : minY;
      out[at + 2] = corner & 4 ? maxZ : minZ;
      at += 3;
    }
  }
  return at;
}

// The capacity a batch of `count` boxes needs: grows by doubling, so a selection that grows one
// item at a time rebuilds its buffers a handful of times, not once per item.
export function batchCapacity(count, current = 0) {
  if (count <= current) return current;
  let next = Math.max(64, current * 2);
  while (next < count) next *= 2;
  return next;
}
