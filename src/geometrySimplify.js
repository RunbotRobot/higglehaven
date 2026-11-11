// One guarded edge-collapse pass over a single geometry. No DOM, no
// network: runs in the browser, in node and in the test runtime.
//
// Extracted from modelOptimizer.js's optimizeModelFile (#3413) so the upload
// optimiser and the model-tier builder (src/modelTiers.js) run the exact same
// guards instead of two copies that drift apart.
// A locally patched copy, not the stock addon — see its own doc comment.
// It carries uv1/uv2/uv3 through decimation, which the stock one drops.
import { SimplifyModifier } from './vendor/SimplifyModifierExtraUV.js';

// #2744: SimplifyModifier's edge-collapse algorithm (both the stock one and
// this repo's vendored copy) has no topology-preserving guarantee -- it can
// and does tear real holes (new boundary edges in a previously closed mesh)
// into the result once a single pass removes too large a fraction of a
// mesh's vertices at once. Confirmed empirically with a standalone probe
// against several unrelated closed shapes (TorusKnot, Sphere, Cylinder): all
// stayed hole-free up through a 60% single-pass removal, and all but Sphere
// had started tearing by 65-70%. Capping how much a single pass may remove
// means an extremely dense mesh comes out larger than the target after one
// pass rather than risking visible holes to hit it in one go. A caller that
// wants a far smaller result runs several passes (see modelTiers.js).
export const MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION = 0.6;

const simplifier = new SimplifyModifier();

export function countTriangles(geometry) {
  const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
  return Math.round(count / 3);
}

// #1552: SimplifyModifier's attribute whitelist doesn't carry skin binding
// through edge-collapse, so decimating a SkinnedMesh silently destroys its
// skinIndex/skinWeight -- breaking equip/animation playback with no error
// surfaced anywhere. A skinned mesh is left undecimated rather than risk its
// rig.
export function isSkinnedGeometry(geometry) {
  return !!(geometry.attributes.skinIndex || geometry.attributes.skinWeight);
}

// Returns a new, simplified geometry, or null when nothing should change
// (already at or under the target, skinned, or nothing removable). The input
// is never modified or disposed; the caller owns both geometries.
//
// #3483: written as a generator that yields between small pieces of work, so a
// caller with a per-frame budget (src/modelTiers.js, building a product's mid
// and far versions in the shopper's browser) can spread one pass across frames.
// A pass on a 50k-triangle mesh took several seconds as one task. The result is
// the same as simplifyGeometryOnePass's.
export function* simplifyGeometryOnePassSteps(geometry, targetTriangles) {
  const triangleCount = countTriangles(geometry);
  if (triangleCount <= targetTriangles) return null;
  if (isSkinnedGeometry(geometry)) return null;

  // #1682: removeCount must land in the same units simplifier.modify()
  // actually operates on. It always merges duplicate vertices internally
  // before collapsing -- a no-op for an already-indexed mesh, but a
  // non-indexed one (one vertex per triangle corner, no sharing) has a raw
  // position.count far larger than its real unique-vertex working set.
  // Without this, removeCount is computed against that inflated raw count
  // and can vastly overshoot the actual mergeable vertices, decimating the
  // mesh down to nothing instead of ~targetTriangles.
  //
  // #3483: the modifier now hands that merged vertex count to this function
  // itself, so the mesh is merged once instead of once to count and again to
  // simplify (each merge is a pass over every triangle corner).
  const removeCountFor = (vertexCount) => {
    const targetVertexCount = Math.max(3, Math.round(vertexCount * (targetTriangles / triangleCount)));
    const uncappedRemoveCount = vertexCount - targetVertexCount;
    if (uncappedRemoveCount <= 0) return 0;
    // #2744: see MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION's own comment.
    return Math.min(uncappedRemoveCount, Math.floor(vertexCount * MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION));
  };

  return yield* simplifier.modifySteps(geometry, removeCountFor);
}

// The same pass run to completion in one go, for callers with nothing to keep
// responsive (the upload optimiser, node scripts, tests).
export function simplifyGeometryOnePass(geometry, targetTriangles) {
  const steps = simplifyGeometryOnePassSteps(geometry, targetTriangles);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}
