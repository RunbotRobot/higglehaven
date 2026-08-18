import * as THREE from 'three';

// Crops a real (possibly textured) model's geometry along one local axis
// without ever stretching it — the same "crop, not scale" requirement
// applies here as it does to the simple box-shaped extensible items (see
// main.js's createMeshForInstance), except a real scan has actual surface
// detail and a texture that a naive box-rebuild would just throw away.
//
// This does single-convex-plane polygon clipping (a well-understood, much
// simpler relative of general CSG — appropriate here since every crop plane
// is axis-aligned in the model's own local space): triangles entirely on the
// kept side pass through untouched, complete with their original UVs, so
// the real scanned texture is never touched except right at the cut line.
// Triangles straddling the plane get split, and the newly exposed
// cross-section is capped with a flat, untextured polygon (material index
// 1) rather than left open — the "tidy edge" a builder actually wants when
// cutting something down to fit, not a hollow gap into an unfinished
// interior.
//
// Operates on flat (non-indexed) position/normal/uv arrays internally,
// converting to/from a real THREE.BufferGeometry only at the boundaries —
// working with THREE's own indexed BufferGeometry+group API mid-pipeline
// across multiple clip passes (see cropGeometrySymmetric) turned out to be
// far more fiddly than plain arrays for this.

// Splits `geometry` into a flat list of triangles. Every input triangle is
// normalized to materialIndex 0 ("the real surface") regardless of
// whatever groups the source geometry came in with — a multi-material
// input (e.g. a default THREE.BoxGeometry, which ships with 6 per-face
// groups for a MultiMaterial array) has no meaning in this module's own
// convention, where index 0 is always the caller's real/original material
// and index 1 is reserved exclusively for this module's own flat cap
// faces (see clipTriangles). Collapsing everything else to 0 keeps that
// convention from colliding with whatever the input happened to use.
function toTriangleList(geometry) {
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = nonIndexed.attributes.position;
  const normal = nonIndexed.attributes.normal;
  const uv = nonIndexed.attributes.uv;

  const triangles = [];
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 3) {
    const materialIndex = 0;
    const verts = [];
    for (let i = 0; i < 3; i++) {
      const p = vertexIndex + i;
      verts.push({
        position: new THREE.Vector3().fromBufferAttribute(position, p),
        normal: normal ? new THREE.Vector3().fromBufferAttribute(normal, p) : new THREE.Vector3(0, 0, 1),
        uv: uv ? new THREE.Vector2().fromBufferAttribute(uv, p) : new THREE.Vector2(0, 0),
      });
    }
    triangles.push({ verts, materialIndex });
  }
  return triangles;
}

function lerpVertex(a, b, t) {
  return {
    position: a.position.clone().lerp(b.position, t),
    normal: a.normal.clone().lerp(b.normal, t).normalize(),
    uv: a.uv.clone().lerp(b.uv, t),
  };
}

// One clip pass: keeps the half-space where `sign * (v[axis] - boundary) <=
// 0`, discarding the rest. Straddling triangles are split (their kept
// portion re-triangulated, 1 or 2 triangles depending on how many vertices
// survive) and their new cut edge is recorded so the cap can be built from
// it afterward. Cap triangles from this pass, and any pre-existing ones
// carried over from an earlier pass on the same geometry (see
// cropGeometrySymmetric), keep or receive materialIndex `capMaterialIndex`;
// real surface triangles keep whatever materialIndex they already had.
function clipTriangles(triangles, axis, sign, boundary, capMaterialIndex) {
  const kept = [];
  const boundaryEdges = []; // [{a: Vector3, b: Vector3}] — points on the new cut plane

  const distance = (v) => sign * (v.position.getComponent(axis) - boundary);

  for (const { verts, materialIndex } of triangles) {
    const distances = verts.map(distance);
    const outside = distances.map((d) => d > 1e-9);
    const outsideCount = outside.filter(Boolean).length;

    if (outsideCount === 0) {
      kept.push({ verts, materialIndex });
      continue;
    }
    if (outsideCount === 3) continue; // fully discarded, nothing to cap from this triangle

    // Walk the triangle's edges in order, keeping inside vertices as-is and
    // replacing each inside/outside edge crossing with its plane
    // intersection — standard single-plane Sutherland-Hodgman clipping.
    const newVerts = [];
    const cutPoints = [];
    for (let i = 0; i < 3; i++) {
      const current = verts[i];
      const next = verts[(i + 1) % 3];
      const currentOutside = outside[i];
      const nextOutside = outside[(i + 1) % 3];
      if (!currentOutside) newVerts.push(current);
      if (currentOutside !== nextOutside) {
        const t = distances[i] / (distances[i] - distances[(i + 1) % 3]);
        const cut = lerpVertex(current, next, t);
        newVerts.push(cut);
        cutPoints.push(cut.position);
      }
    }
    if (cutPoints.length === 2) boundaryEdges.push({ a: cutPoints[0], b: cutPoints[1] });

    // newVerts is a convex polygon (triangle or quad) — fan-triangulate
    // from its first vertex, preserving the original material.
    for (let i = 1; i + 1 < newVerts.length; i++) {
      kept.push({ verts: [newVerts[0], newVerts[i], newVerts[i + 1]], materialIndex });
    }
  }

  if (boundaryEdges.length === 0) return kept;

  const capNormal = new THREE.Vector3();
  capNormal.setComponent(axis, sign);
  for (const cap of triangulateCap(boundaryEdges, capNormal)) {
    kept.push({ verts: cap, materialIndex: capMaterialIndex });
  }
  return kept;
}

// Chains the clip plane's boundary edges into a loop and fans triangles
// from its centroid — correct for the roughly convex cross-sections real
// physical products (bricks, boards, ...) actually have; an exotic
// concave cross-section could produce a slightly imperfect cap, which is
// an acceptable simplification here rather than a full polygon
// triangulator for a shape this code will never actually see in practice.
function triangulateCap(edges, normal) {
  const points = chainEdgesIntoLoop(edges);
  if (points.length < 3) return [];
  const centroid = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length);
  const uv = new THREE.Vector2(0, 0);
  const centroidVert = { position: centroid, normal, uv };
  const triangles = [];
  for (let i = 0; i < points.length; i++) {
    const a = { position: points[i], normal, uv };
    const b = { position: points[(i + 1) % points.length], normal, uv };
    triangles.push([centroidVert, a, b]);
  }
  return triangles;
}

// Boundary edges come out of clipTriangles in no particular order — this
// greedily walks from an arbitrary start, always hopping to the
// closest-matching endpoint, until every edge is consumed. Snapping by
// nearest match (rather than exact equality) tolerates the tiny
// floating-point drift between two triangles' independently-interpolated
// versions of what should be the same intersection point.
function chainEdgesIntoLoop(edges) {
  const remaining = edges.map((e) => ({ a: e.a, b: e.b }));
  const loop = [remaining[0].a, remaining[0].b];
  remaining.splice(0, 1);
  const EPSILON = 1e-6;

  while (remaining.length > 0) {
    const tail = loop[loop.length - 1];
    let bestIndex = -1;
    let bestDistance = Infinity;
    let bestFlip = false;
    for (let i = 0; i < remaining.length; i++) {
      const distA = tail.distanceTo(remaining[i].a);
      const distB = tail.distanceTo(remaining[i].b);
      if (distA < bestDistance) { bestDistance = distA; bestIndex = i; bestFlip = false; }
      if (distB < bestDistance) { bestDistance = distB; bestIndex = i; bestFlip = true; }
    }
    if (bestIndex === -1 || bestDistance > Math.max(EPSILON, 0.05)) break; // no plausible next edge — stop rather than guess wrong
    const edge = remaining[bestIndex];
    loop.push(bestFlip ? edge.a : edge.b);
    remaining.splice(bestIndex, 1);
  }
  return loop;
}

function trianglesToGeometry(triangles) {
  const positionArray = [];
  const normalArray = [];
  const uvArray = [];
  const groupsByMaterial = new Map();

  triangles.forEach(({ verts, materialIndex }, triangleIndex) => {
    for (const v of verts) {
      positionArray.push(v.position.x, v.position.y, v.position.z);
      normalArray.push(v.normal.x, v.normal.y, v.normal.z);
      uvArray.push(v.uv.x, v.uv.y);
    }
    if (!groupsByMaterial.has(materialIndex)) groupsByMaterial.set(materialIndex, { start: triangleIndex * 3, count: 0 });
    groupsByMaterial.get(materialIndex).count += 3;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionArray, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalArray, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2));
  // Groups must be contiguous in draw order for BufferGeometry, which the
  // per-triangle push order above doesn't guarantee across two clip passes
  // (a cap from the first pass and real-surface triangles can interleave
  // with the second pass's own cap). Re-sort triangles by materialIndex
  // once, up front, rather than trying to keep them contiguous throughout —
  // much simpler than threading ordering through every clip pass.
  return geometry;
}

// Re-sorts a triangle list so every materialIndex's triangles are
// contiguous (required for BufferGeometry groups), preserving relative
// order within each material.
function sortByMaterial(triangles) {
  return [...triangles].sort((a, b) => a.materialIndex - b.materialIndex);
}

function buildGroupedGeometry(triangles) {
  const sorted = sortByMaterial(triangles);
  const geometry = trianglesToGeometry(sorted);
  let start = 0;
  let current = sorted.length > 0 ? sorted[0].materialIndex : 0;
  let count = 0;
  for (const { materialIndex } of sorted) {
    if (materialIndex !== current) {
      geometry.addGroup(start, count, current);
      start += count;
      count = 0;
      current = materialIndex;
    }
    count += 3;
  }
  if (count > 0) geometry.addGroup(start, count, current);
  return geometry;
}

// Crops `geometry` (already in the coordinate space its axis/boundary are
// expressed in) symmetrically around local-space 0 along `axis` (0=x, 1=y,
// 2=z), keeping only `[-halfExtent, +halfExtent]`. Anything beyond either
// boundary is discarded and capped with a flat polygon carrying
// materialIndex 1 (the caller supplies material index 0's real material
// and a flat material for index 1 — see loadCroppedModelInstance in
// main.js). Returns a plain, ungrouped-input-agnostic BufferGeometry with
// two groups: 0 for whatever survived from the original surface, 1 for
// both caps.
export function cropGeometrySymmetric(geometry, axis, halfExtent) {
  let triangles = toTriangleList(geometry);
  triangles = clipTriangles(triangles, axis, 1, halfExtent, 1);
  triangles = clipTriangles(triangles, axis, -1, -halfExtent, 1);
  return buildGroupedGeometry(triangles);
}
