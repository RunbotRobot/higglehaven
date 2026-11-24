// One guarded edge-collapse pass over a single geometry. No DOM, no
// network: runs in the browser, in node and in the test runtime.
//
// Extracted from modelOptimizer.js's optimizeModelFile (#3413) so the upload
// optimiser and the model-tier builder (src/modelTiers.js) run the exact same
// guards instead of two copies that drift apart.
// A locally patched copy, not the stock addon — see its own doc comment.
// It carries uv1/uv2/uv3 through decimation, which the stock one drops.
import { Vector3 } from 'three';
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
export function* simplifyGeometryOnePassSteps(geometry, targetTriangles, maxRemovalFraction = MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION, options = {}) {
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
    return Math.min(uncappedRemoveCount, Math.floor(vertexCount * maxRemovalFraction));
  };

  return yield* simplifier.modifySteps(geometry, removeCountFor, options);
}

// #3528: how many edges of a geometry belong to exactly one triangle, with
// vertices that share a position counted as one (so a seam that only splits UVs
// or normals is not a hole). A closed model has none; a model with a hole, or
// a mesh the simplifier tore open, has some. Yields every few thousand corners
// so a caller with a frame budget can spread it, the same as the pass itself.
// Comparing the count before and after a pass is how a tear is noticed.
const BOUNDARY_CHUNK_CORNERS = 6000;
export function* boundaryEdgeCountSteps(geometry) {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const corners = index ? index.count : position.count;
  if (!position || corners < 3) return 0;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new Vector3());
  // Weld within a hundred-thousandth of the model's own size, so the test means
  // the same for a mug and for a house.
  const cell = Math.max(size.length() * 1e-5, 1e-9);
  const ids = new Map();
  const idOf = (i) => {
    const key = `${Math.round(position.getX(i) / cell)},${Math.round(position.getY(i) / cell)},${Math.round(position.getZ(i) / cell)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    return id;
  };
  const uses = new Map();
  for (let c = 0; c + 2 < corners; c += 3) {
    const a = idOf(index ? index.getX(c) : c);
    const b = idOf(index ? index.getX(c + 1) : c + 1);
    const d = idOf(index ? index.getX(c + 2) : c + 2);
    if (a !== b && b !== d && a !== d) {
      for (const [x, y] of [[a, b], [b, d], [d, a]]) {
        const key = x < y ? `${x}-${y}` : `${y}-${x}`;
        uses.set(key, (uses.get(key) || 0) + 1);
      }
    }
    if (c % BOUNDARY_CHUNK_CORNERS === 0 && c > 0) yield;
  }
  let boundary = 0;
  for (const n of uses.values()) if (n === 1) boundary++;
  return boundary;
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
