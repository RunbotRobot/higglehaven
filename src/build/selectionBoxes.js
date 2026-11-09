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
