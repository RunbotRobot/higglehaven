import * as THREE from 'three';

// Crops a real (possibly textured) model's geometry along one local axis
// without ever stretching it — the same "crop, not scale" requirement
// applies here as it does to the simple box-shaped extensible items (see
// main.js's createMeshForInstance), except a real scan has actual surface
// detail and a texture that a naive box-rebuild would just throw away.
//
// The crop is one-sided, not symmetric: the local -axis end is the
// "anchor" and is never touched at all — its real geometry, including
// whatever end cap the product actually shipped with, survives completely
// untouched. The local +axis end is the "cut" end — but even there, rather
// than manufacturing a flat, single-color disc, this reuses the product's
// own *original* end cap (the real triangles that were already sitting at
// its true, uncropped +axis extreme), rigidly translated inward to the new
// boundary. So a crop never introduces a fabricated-looking surface at
// all — it just looks like a shorter version of the same real product,
// which is what "cut a physical brick down" should actually look like.
// A very thin flat manufactured cap is still built behind that translated
// real cap purely as an invisible safety backing (see cropGeometryFromEnd)
// in case the two don't nest perfectly — cheap insurance, never meant to
// be seen.
//
// This does single-convex-plane polygon clipping (a well-understood, much
// simpler relative of general CSG — appropriate here since every crop plane
// is axis-aligned in the model's own local space): triangles entirely on the
// kept side pass through untouched, complete with their original UVs, so
// the real scanned texture is never touched except right at a cut line.
// Triangles straddling a plane get split, and the newly exposed
// cross-section is capped with a flat polygon (material index 1) rather
// than left open — the "tidy edge" a builder actually wants, not a hollow
// gap into an unfinished interior.
//
// Operates on flat (non-indexed) position/normal/uv arrays internally,
// converting to/from a real THREE.BufferGeometry only at the boundaries —
// working with THREE's own indexed BufferGeometry+group API mid-pipeline
// across multiple clip passes turned out to be far more fiddly than plain
// arrays for this.

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
// survive) and their new cut edge is recorded so a cap can be built from
// it afterward, tagged with materialIndex `capMaterialIndex`. Real surface
// triangles keep whatever materialIndex they already had. Returns the kept
// triangles alongside the raw boundary edges themselves (not just the cap
// built from them) — cropGeometryFromEnd needs those to measure the actual
// cross-section it's trying to cover (see loopExtent).
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

  if (boundaryEdges.length > 0) {
    const capNormal = new THREE.Vector3();
    capNormal.setComponent(axis, sign);
    for (const cap of triangulateCap(boundaryEdges, capNormal)) {
      kept.push({ verts: cap, materialIndex: capMaterialIndex });
    }
  }
  return { triangles: kept, boundaryEdges };
}

// Chains the clip plane's boundary edges into a loop and fans triangles
// from its centroid — correct for the roughly convex cross-sections real
// physical products (bricks, boards, ...) actually have; an exotic
// concave cross-section could produce a slightly imperfect cap, which is
// an acceptable simplification here rather than a full polygon
// triangulator for a shape this code will rarely see in practice.
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
// closest-matching endpoint, until every edge is consumed. Always
// consumes *something* each step (no distance cutoff that gives up
// early) — a raw scanned/exported mesh commonly has real seams (T-
// junctions, unwelded duplicate vertices at shared edges) that keep two
// independently-interpolated copies of "the same" intersection point from
// landing bit-identical, and previously, a hard distance threshold here
// let the loop-closing bail out early on exactly that kind of mesh,
// leaving the cap only partially triangulated — a real hole into the
// model's hollow interior, not just a cosmetically imperfect cap. A
// closed-but-imperfect loop beats an open one every time.
function chainEdgesIntoLoop(edges) {
  const remaining = edges.map((e) => ({ a: e.a, b: e.b }));
  const loop = [remaining[0].a, remaining[0].b];
  remaining.splice(0, 1);

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

  for (const { verts } of triangles) {
    for (const v of verts) {
      positionArray.push(v.position.x, v.position.y, v.position.z);
      normalArray.push(v.normal.x, v.normal.y, v.normal.z);
      uvArray.push(v.uv.x, v.uv.y);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionArray, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalArray, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2));
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

function translateTriangles(triangles, axis, delta) {
  return triangles.map(({ verts, materialIndex }) => ({
    materialIndex,
    verts: verts.map((v) => {
      const position = v.position.clone();
      position.setComponent(axis, position.getComponent(axis) + delta);
      return { position, normal: v.normal, uv: v.uv };
    }),
  }));
}

// A boundary loop's bounding box in the two axes *other* than the crop
// axis — the "footprint" a cap needs to cover, seen looking straight down
// the crop axis. Bounding-box (not true centroid/radius) is deliberately
// simple, matching triangulateCap's own "roughly convex real product"
// assumption elsewhere in this file.
function loopExtent(edges, uIndex, vIndex) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const edge of edges) {
    for (const p of [edge.a, edge.b]) {
      const u = p.getComponent(uIndex);
      const v = p.getComponent(vIndex);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  return {
    centerU: (minU + maxU) / 2,
    centerV: (minV + maxV) / 2,
    extentU: Math.max(maxU - minU, 1e-6),
    extentV: Math.max(maxV - minV, 1e-6),
  };
}

// Recenters and scales a triangle list within the plane perpendicular to
// the crop axis — used to fit a lifted end cap onto a hole it wasn't
// originally shaped for (see cropGeometryFromEnd). Never touches the crop
// axis component itself.
function fitTrianglesInPlane(triangles, uIndex, vIndex, from, to, scaleU, scaleV) {
  return triangles.map(({ verts, materialIndex }) => ({
    materialIndex,
    verts: verts.map((v) => {
      const position = v.position.clone();
      const u = (position.getComponent(uIndex) - from.centerU) * scaleU + to.centerU;
      const val = (position.getComponent(vIndex) - from.centerV) * scaleV + to.centerV;
      position.setComponent(uIndex, u);
      position.setComponent(vIndex, val);
      return { position, normal: v.normal, uv: v.uv };
    }),
  }));
}

// What fraction of the *original, uncropped* length is treated as "the end
// cap region" to lift and reuse — thin enough to stay a small sliver of
// the product even when it's cropped down a lot, thick enough to reliably
// catch a few real rows of geometry even on a coarse mesh. This is only
// the *starting point* for pickCapThickness's search below, not a fixed
// value — see there for why a fixed thickness isn't reliable on its own.
const MIN_CAP_SLAB_FRACTION = 0.025;
// How far the search below is allowed to grow the slab before giving up
// and using whatever it last measured — bounded by two different lengths,
// whichever is shorter. Against the kept length (cropLength), so a very
// short crop can't have the slab balloon to consume most of the remaining
// piece. And, just as importantly, against the amount actually being cut
// away (fullHalf - newBoundary): the relocated cap's own outer face always
// ends up newBoundary + capThickness units from center (see
// cropGeometryFromEnd's translateTriangles call — the slab's far face,
// originally at fullHalf, lands at fullHalf + (newBoundary - capBoundary),
// which is exactly newBoundary + capThickness since capBoundary = fullHalf
// - capThickness), so a capThickness bigger than what's actually being
// removed pushes that face *past* the original, uncropped model's own tip
// — a "cropped" result literally longer than the source. A light crop
// combined with an unrepresentative tip (the very scenario this search
// exists for) can genuinely need to grow past that amount before this
// function's own coverage-ratio check would otherwise accept it, so this
// second bound has to apply even when it's the tighter of the two.
const MAX_CAP_SLAB_FRACTION_OF_CROP = 0.6;
// A patch within this factor of the hole it needs to cover is accepted
// without growing the slab further — some scale correction is fine (see
// fitTrianglesInPlane below), it's only a *large* one that means the slab
// was lifted from a not-yet-representative part of the surface.
const ACCEPTABLE_COVERAGE_RATIO = 1.15;

// Real scanned geometry is least reliable right at its own true silhouette
// edge (the surface a camera rig sees at the shallowest, most occluded
// angles), so a thin slab lifted from *right at the tip* can measure a
// meaningfully worse cross-section than the product's healthy body just a
// little further in — not a smooth taper, but a sharp transition: on one
// real scanned brick, a slab thickness of 0.89cm measured a cross-section
// barely 60% of the cut boundary's own extent on one axis, while just
// 2cm in, it measured within 2% — a step change, not a gradual one. A
// single fixed thickness can't safely split the difference between "thin
// enough to stay a sliver" and "thick enough to clear the unreliable
// edge zone" for every product, since where that edge zone ends varies by
// scan. Instead, start thin and double the slab until its own
// freshly-cut cross-section (measured right where it will need to meet
// the main body's hole) is actually within reach of that hole without a
// large stretch, or until MAX_CAP_SLAB_FRACTION_OF_CROP's ceiling is hit —
// whichever comes first. A product whose edge is fine at the starting
// thickness (the common case) pays nothing extra; one like the brick
// above grows only as much as it actually needs to.
function pickCapThickness(all, axis, fullHalf, newBoundary, cropLength, uIndex, vIndex, hole) {
  const minThickness = fullHalf * 2 * MIN_CAP_SLAB_FRACTION;
  const maxThickness = Math.min(cropLength, fullHalf - newBoundary) * MAX_CAP_SLAB_FRACTION_OF_CROP;
  let best = null;
  for (let thickness = minThickness; ; thickness *= 2) {
    const capped = Math.min(thickness, maxThickness);
    const capBoundary = fullHalf - capped;
    const result = clipTriangles(all, axis, -1, capBoundary, 1);
    if (result.boundaryEdges.length > 0) {
      const patch = loopExtent(result.boundaryEdges, uIndex, vIndex);
      const ratioU = hole.extentU > patch.extentU ? hole.extentU / patch.extentU : 1;
      const ratioV = hole.extentV > patch.extentV ? hole.extentV / patch.extentV : 1;
      best = { ...result, patch, capThickness: capped };
      if (ratioU <= ACCEPTABLE_COVERAGE_RATIO && ratioV <= ACCEPTABLE_COVERAGE_RATIO) break;
    }
    if (capped >= maxThickness) break; // hit the ceiling — use the best measured so far
  }
  return best;
}

// Crops `geometry` (already centered at local-space 0, matching how
// loadModelInstance recenters every loaded model) down to `cropLength`
// along `axis` (0=x, 1=y, 2=z), out of an original full length of
// `fullLength`. The local -axis half is the anchor and is returned
// completely untouched, real end cap included. The local +axis half is
// cut down to the new boundary, but capped by lifting the product's own
// original +axis end-cap geometry (whatever real triangles were already
// sitting at its true, uncropped extreme) and translating it inward,
// rather than a fabricated flat disc — see this file's top doc comment.
// Returns a geometry with two material groups: 0 for every real surface
// (both the untouched anchor half and the reused, relocated cap), 1 for
// the thin backing cap hidden just behind it.
export function cropGeometryFromEnd(geometry, axis, cropLength, fullLength) {
  const fullHalf = fullLength / 2;
  const newBoundary = -fullHalf + cropLength;
  if (newBoundary >= fullHalf - 1e-9) return geometry; // nothing to crop

  const all = toTriangleList(geometry);
  // The rest of the product, cut down to the new boundary. Anything
  // between newBoundary and the reused cap (below) is genuinely
  // discarded — that's the material actually being "cut away".
  const { triangles: mainBody, boundaryEdges: mainEdges } = clipTriangles(all, axis, 1, newBoundary, 1);

  const [uIndex, vIndex] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const hole = mainEdges.length > 0 ? loopExtent(mainEdges, uIndex, vIndex) : null;
  // The product's real end cap: everything from the true, uncropped
  // +axis extreme in by however thick pickCapThickness decides it needs
  // to be — extracted via the same clip primitive as everything else, so
  // it comes out already a clean, watertight little slab (including its
  // own back face, which becomes the hidden backing once relocated).
  const picked = hole ? pickCapThickness(all, axis, fullHalf, newBoundary, cropLength, uIndex, vIndex, hole) : null;

  if (!picked) return buildGroupedGeometry(mainBody);
  const { triangles: capSlab, patch, capThickness } = picked;
  const capBoundary = fullHalf - capThickness;

  let fittedCap = translateTriangles(capSlab, axis, newBoundary - capBoundary);
  // The lifted cap's own cross-section (patch) still isn't guaranteed to
  // *exactly* match the main body's cross-section at the new cut boundary
  // (hole) even after pickCapThickness's search — real scanned products
  // can genuinely taper a little even away from the unreliable edge zone.
  // Recentering the translated cap onto the main body's own hole, and
  // scaling it up (never down, so real geometry is only ever stretched to
  // fit, never shaved away) just enough in the cross-sectional plane to
  // guarantee full coverage, keeps whatever's actually visible at the
  // boundary the real surface.
  const COVERAGE_MARGIN = 1.02;
  const scaleU = hole.extentU > patch.extentU ? (hole.extentU / patch.extentU) * COVERAGE_MARGIN : 1;
  const scaleV = hole.extentV > patch.extentV ? (hole.extentV / patch.extentV) * COVERAGE_MARGIN : 1;
  fittedCap = fitTrianglesInPlane(fittedCap, uIndex, vIndex, patch, hole, scaleU, scaleV);

  return buildGroupedGeometry([...mainBody, ...fittedCap]);
}
