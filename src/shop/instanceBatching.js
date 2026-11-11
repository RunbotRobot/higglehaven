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
// - a placement the builder cropped (its geometry is its own);
// - an extensible template (one the builder can cut down): it loads through the
//   cropping path, whose geometry is not guaranteed to equal the plain model's,
//   so it keeps its own mesh until that is verified (#3402 left it out).
// The scale is part of the key so every placement in a batch is one size.
export function batchKey(instance, template) {
  if (!instance || !template) return null;
  if (!template.modelUrl) return null;
  if (template.metadata?.flooring === true) return null;
  if (template.metadata?.extensible) return null;
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

// #3401: the userData every placed (non-flooring) instance carries, in one
// place so a built mesh (createMeshForInstance) and a geometry-free handle
// (createPlacementHandle) cannot drift apart. Collision, sit/lean search,
// level of detail, signs, calendars and reviews all read these fields off the
// object in entry.objects, so a handle that has them is interchangeable for
// all of those; meshDimensions reads only template, crop and scale from here,
// never geometry, so a handle needs no cached dimensions of its own.
export function placementUserData(instance, template) {
  return {
    instanceId: instance.instanceId ?? instance.id,
    template,
    crop: { ...(instance.crop || {}) },
    scale: instance.scale ?? 1,
    isCommunitySign: instance.isCommunitySign ?? false,
    isCommunityCalendar: instance.isCommunityCalendar ?? false,
    groupId: instance.groupId ?? null,
    bundleId: instance.bundleId ?? null,
    label: instance.label ?? null,
  };
}

// #3402: how high a placement reaches, for growing the Shop dome without
// measuring geometry. `dims` is meshDimensions(handle) (already scaled). An
// upright or turned-about-vertical item reaches half its height above its
// centre; a tilted one can reach as far as half its diagonal, so that is used
// (an upper bound, never too low).
export function placementTopZ(z, rotationX, rotationY, dims) {
  const tilted = (rotationX ?? 0) !== 0 || (rotationY ?? 0) !== 0;
  return z + (tilted ? 0.5 * Math.hypot(dims.width, dims.depth, dims.height) : dims.height / 2);
}

// #3402: the placement handle a raycast hit on a batch's instanced mesh refers
// to: `handles` is the batch's handle list in instance order (the same order
// the instance matrices were written), `instanceId` is three.js's hit field.
export function handleForInstanceHit(handles, instanceId) {
  if (!Array.isArray(handles) || !Number.isInteger(instanceId)) return null;
  return handles[instanceId] ?? null;
}
