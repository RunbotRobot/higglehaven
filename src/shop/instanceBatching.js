// #3400 (part of #3398): which placed items may be drawn together as one
// instanced mesh. Pure (instances and templates in, groups out) so it is
// unit-testable without three.js, like src/skeletonSignature.js.
//
// Why: a wall of 829 identical bricks is 829 cloned meshes and 829 draw calls
// today. Items that look exactly the same can share one geometry and be drawn
// by one InstancedMesh with a matrix per placement. Every placement still gets
// its own lightweight handle object (#3401) so collision, sit/lean search,
// level of detail and tap resolution keep working; only the drawing is shared.
// This module only decides the grouping.

// A batch smaller than this is not worth the extra machinery: a handful of
// chairs stay ordinary meshes.
export const MIN_BATCH_SIZE = 4;

// Shape of a crop the builder applied: { x, y, z } lengths, any may be absent.
function isCropped(crop) {
  if (!crop || typeof crop !== 'object') return false;
  return Object.values(crop).some((value) => typeof value === 'number');
}

// The string two placements share exactly when one batch may draw both, or
// null when the placement must keep its own mesh:
// - no template, or no real model (a plain coloured box has nothing to share);
// - flooring (a thin tinted slab built by its own path);
// - a community sign or calendar (each needs its own sprite and hit target);
// - a placement the builder cropped (its geometry is its own).
// An extensible template (a brick that can be cut down) is batchable while the
// instance is uncropped; the renderer (#3402) must confirm the uncropped
// cropped-loader result matches the plain model before relying on that.
// The scale is part of the key so a batch's cached dimensions are one number.
export function batchKey(instance, template) {
  if (!instance || !template) return null;
  if (!template.modelUrl) return null;
  if (template.metadata?.flooring === true) return null;
  if (instance.isCommunitySign || instance.isCommunityCalendar) return null;
  if (isCropped(instance.crop)) return null;
  const scale = instance.scale ?? 1;
  return `${template.templateId}|${template.modelUrl}|${scale}`;
}

// instances: the landlet's placements in file order. templateFor(templateId)
// returns the catalog template or undefined.
// Returns { batches: Map<key, instance[]>, singles: instance[] }. A batch's
// array position is each placement's stable instance index inside it; file
// order is preserved inside every batch and in `singles`. Groups smaller than
// minBatchSize fall back to singles.
export function groupPlacements(instances, templateFor, minBatchSize = MIN_BATCH_SIZE) {
  const list = Array.isArray(instances) ? instances : [];
  const groups = new Map();
  const keyed = list.map((instance) => {
    const key = batchKey(instance, templateFor(instance?.templateId));
    if (key !== null) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(instance);
    }
    return key;
  });
  const batches = new Map();
  for (const [key, members] of groups) {
    if (members.length >= minBatchSize) batches.set(key, members);
  }
  const singles = list.filter((_, index) => keyed[index] === null || !batches.has(keyed[index]));
  return { batches, singles };
}
