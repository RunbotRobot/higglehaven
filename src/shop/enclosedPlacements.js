// #4365 (found under #4293, "E1"): a placement whose every face is covered by its neighbours cannot be seen
// from anywhere outside the solid they make together, yet a wall of 1,650 bricks draws all of them: 477 of
// the owner's wall are inside it, about 1.26M of the 4.95M triangles drawn from 5 to 35 m. This file is the
// rule for which placements those are. It is pure arithmetic over boxes (no three.js, no scene) so the rule
// can be tested exhaustively; src/shop/enclosedBatch.js feeds it the real placements and applies the answer.
//
// DECIDED under "The system may group things for its own efficiency, invisibly": what is drawn changes,
// what can be selected, walked into or bought does not (the placement stays in entry.objects, with its
// handle, collision and review; only its instanced matrix is left out of the drawn sets).
//
// THE RULE. A placement is ENCLOSED when all six of its faces are covered. Seen in the placement's own
// frame it is a box (centre, three perpendicular half-extents). A face is covered when the neighbours that
// meet it together hide all of it:
//  1. A neighbour counts for a face only if it is a box in the SAME orientation as the placement (its axes
//     are the placement's axes, in any order and either way round, within AXIS_TOLERANCE). A neighbour at any
//     other angle covers nothing, however close.
//  2. It must stand on the far side of the face: its box reaches back to the face plane (within
//     SEAM_TOLERANCE_M) and at least MIN_COVER_DEPTH_M beyond it.
//  3. The part of the face a neighbour hides is where its own box overlaps the face. The union of those
//     rectangles must cover the whole face shrunk by SEAM_TOLERANCE_M on every side (an exact rectangle
//     union, not a sample). A brick in a running bond is covered by two bricks half a brick apart; a brick in
//     a stack by one.
//  4. Every box in the solid must itself fill its box and be opaque: the caller's checks on the model (solidFill,
//     enclosedBatch.js), made for every version the batch can draw, and a batch that fails them culls nothing.
//  5. A placement with more than MAX_NEIGHBOURS neighbours is drawn (a dense pile is not a wall).
// Anything else is NOT enclosed: an edge brick, a brick with one half-covered face, a gap wider than
// SEAM_TOLERANCE_M, a neighbour turned a degree, a neighbour of another product. When in doubt it is drawn.
//
// Why it is safe to leave an enclosed placement out while its neighbours may be enclosed too: a surface that
// can be seen is on the outside of the union of the solids, and every point of that outside lies on a face
// that is not fully covered, which belongs to a placement this rule never culls. Covering is about where the
// solids are, not about which of them are drawn, so a chain of culled placements is still sealed.
export const SEAM_TOLERANCE_M = 0.002; // 2 mm: the largest crack the rule will ignore between two bricks
export const MIN_COVER_DEPTH_M = 0.01;
export const AXIS_TOLERANCE = 1e-6; // 1 - |cos| of the angle between two axes: about 0.08 degrees, under a millimetre across a brick
export const FILL_MIN = 0.999; // volume over bounding-box volume: a slot or a through-hole shows sky through the outer brick
export const FACE_COVER_MIN = 0.999; // the triangles lying IN each of the six bounding-box planes must cover this much of that face
export const MAX_SOLID_TRIANGLES = 8000; // a model denser than this is not examined (the check costs a frame's worth); it is drawn whole
export const MAX_SOLID_ASPECT = 10; // longest bounding-box side over shortest: a plank or a pole is not a brick
export const MAX_NEIGHBOURS = 64; // a placement with more neighbours than this is drawn: a dense pile is not a wall
const WELD_M = 1e-4; // vertices closer than this are one (a model with a vertex per face is still one surface)
const WELD_SPAN = 131072; // 2^17 welded steps per axis: 13 m of model at WELD_M
const PLANE_M = 2e-4; // a vertex this close to a bounding-box plane lies in it
const FILL_CHUNK = 1024;

// How much of its bounding box a closed model fills, from its triangles (model space, already through the
// part matrices). A box when ALL of: the surface is closed and consistently wound (every edge walked once each way,
// so no hole, no missing face), the signed volume is at least FILL_MIN of the bounding box, and the triangles lying
// in each of the six bounding-box planes cover at least FACE_COVER_MIN of that face (a chamfer or a recess in a
// face fails this: it is then drawn whole, never culled around). positions: flat [x,y,z,...]; index: flat
// triangle indices or null for a triangle list.
//
// Written as a generator so a caller can work it in slices (createSolidFillJob); solidFill runs it to the end.
function* solidFillSteps(positions, index) {
  const count = positions.length / 3;
  if (count < 4) return { box: false, fill: 0 };
  const triangles = index ? index.length / 3 : Math.floor(count / 3);
  if (triangles < 4 || triangles > MAX_SOLID_TRIANGLES) return { box: false, fill: 0 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (!Number.isFinite(v)) return { box: false, fill: 0 };
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
    if (i % FILL_CHUNK === FILL_CHUNK - 1) yield;
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const boxVolume = size[0] * size[1] * size[2];
  if (!(boxVolume > 0)) return { box: false, fill: 0 };
  if (Math.max(...size) > MAX_SOLID_ASPECT * Math.min(...size) || Math.max(...size) / WELD_M >= WELD_SPAN) return { box: false, fill: 0 };
  const welded = new Map();
  const ids = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const ix = Math.round((positions[i * 3] - min[0]) / WELD_M);
    const iy = Math.round((positions[i * 3 + 1] - min[1]) / WELD_M);
    const iz = Math.round((positions[i * 3 + 2] - min[2]) / WELD_M);
    const key = (ix * WELD_SPAN + iy) * WELD_SPAN + iz;
    let id = welded.get(key);
    if (id === undefined) { id = welded.size; welded.set(key, id); }
    ids[i] = id;
    if (i % FILL_CHUNK === FILL_CHUNK - 1) yield;
  }
  const edges = new Map(); // a * count + b (a < b) -> [a->b uses, b->a uses]; closed iff each is used once each way
  const faceArea = [0, 0, 0, 0, 0, 0]; // min and max plane of each axis
  let volume = 0;
  const idCount = welded.size;
  for (let t = 0; t < triangles; t++) {
    const ia = index ? index[t * 3] : t * 3;
    const ib = index ? index[t * 3 + 1] : t * 3 + 1;
    const ic = index ? index[t * 3 + 2] : t * 3 + 2;
    const a = ids[ia]; const b = ids[ib]; const c = ids[ic];
    if (a !== b && b !== c && a !== c) { // a sliver welded to a line has no area and no edges
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const forward = from < to;
        const k = forward ? from * idCount + to : to * idCount + from;
        let entry = edges.get(k);
        if (!entry) { entry = [0, 0]; edges.set(k, entry); }
        entry[forward ? 0 : 1] += 1;
      }
    }
    const ax = positions[ia * 3]; const ay = positions[ia * 3 + 1]; const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3]; const by = positions[ib * 3 + 1]; const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3]; const cy = positions[ic * 3 + 1]; const cz = positions[ic * 3 + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const va = [ax, ay, az]; const vb = [bx, by, bz]; const vc = [cx, cy, cz];
    for (let axis = 0; axis < 3; axis++) {
      for (let side = 0; side < 2; side++) {
        const plane = side ? max[axis] : min[axis];
        if (Math.abs(va[axis] - plane) > PLANE_M || Math.abs(vb[axis] - plane) > PLANE_M || Math.abs(vc[axis] - plane) > PLANE_M) continue;
        const u = (axis + 1) % 3; const v = (axis + 2) % 3;
        faceArea[axis * 2 + side] += Math.abs((vb[u] - va[u]) * (vc[v] - va[v]) - (vc[u] - va[u]) * (vb[v] - va[v])) / 2;
      }
    }
    if (t % FILL_CHUNK === FILL_CHUNK - 1) yield;
  }
  for (const [forward, backward] of edges.values()) if (forward !== 1 || backward !== 1) return { box: false, fill: 0 };
  for (let axis = 0; axis < 3; axis++) {
    const full = size[(axis + 1) % 3] * size[(axis + 2) % 3];
    if (faceArea[axis * 2] < FACE_COVER_MIN * full || faceArea[axis * 2 + 1] < FACE_COVER_MIN * full) return { box: false, fill: 0 };
  }
  const fill = volume / boxVolume;
  return { box: fill >= FILL_MIN && fill <= 1 + 1e-6, fill, min, max };
}

export function solidFill(positions, index) {
  const it = solidFillSteps(positions, index);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// The same, worked in slices: step(budgetMs, now) does about that much and returns the verdict when finished, null
// while there is more.
export function createSolidFillJob(positions, index) {
  const it = solidFillSteps(positions, index);
  let result = null;
  return {
    get done() { return result !== null; },
    step(budgetMs, now = () => performance.now()) {
      if (result) return result;
      const start = now();
      do {
        const r = it.next();
        if (r.done) { result = r.value; return result; }
      } while (now() - start < budgetMs);
      return null;
    },
  };
}

// The box a placement occupies, in the parent's frame: `matrix` is the placement's 4x4 (column-major, as
// three.js keeps it), `min`/`max` the model's own bounds. Returns { c, axes: [3 unit vectors], h: [3] }.
export function placementBox(matrixElements, min, max) {
  const m = matrixElements;
  const lc = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const lh = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  const c = [
    m[0] * lc[0] + m[4] * lc[1] + m[8] * lc[2] + m[12],
    m[1] * lc[0] + m[5] * lc[1] + m[9] * lc[2] + m[13],
    m[2] * lc[0] + m[6] * lc[1] + m[10] * lc[2] + m[14],
  ];
  const axes = [];
  const h = [];
  for (let a = 0; a < 3; a++) {
    const x = m[a * 4]; const y = m[a * 4 + 1]; const z = m[a * 4 + 2];
    const length = Math.hypot(x, y, z);
    axes.push(length > 0 ? [x / length, y / length, z / length] : [0, 0, 0]);
    h.push(lh[a] * length);
  }
  return { c, axes, h };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// If box `n`'s axes are box `m`'s axes in some order and direction, returns for each of m's axes which of
// n's axes lies along it; otherwise null.
function alignedPermutation(m, n) {
  const used = [false, false, false];
  const perm = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    let found = -1;
    for (let b = 0; b < 3; b++) {
      const d = Math.abs(dot(m.axes[a], n.axes[b]));
      if (d >= 1 - AXIS_TOLERANCE) { found = b; break; }
    }
    if (found < 0 || used[found]) return null;
    used[found] = true;
    perm[a] = found;
  }
  return perm;
}

// Do the rectangles [x0,x1,y0,y1] together cover [-w, w]x[-d, d]? Exact: cut at every x edge; in each slab the
// rectangles that span it are swept by y.
function coversRect(rects, w, d) {
  if (w <= 0 || d <= 0) return true;
  const xs = [-w, w];
  for (const r of rects) {
    if (r[0] > -w && r[0] < w) xs.push(r[0]);
    if (r[1] > -w && r[1] < w) xs.push(r[1]);
  }
  xs.sort((p, q) => p - q);
  const spanning = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i + 1] - xs[i] < 1e-9) continue;
    const mx = (xs[i] + xs[i + 1]) / 2;
    spanning.length = 0;
    for (const r of rects) if (mx >= r[0] && mx <= r[1] && r[3] > -d && r[2] < d) spanning.push(r);
    if (spanning.length === 0) return false;
    spanning.sort((p, q) => p[2] - q[2]);
    let reached = -d;
    for (const r of spanning) {
      if (r[2] > reached + 1e-9) return false; // a gap in y
      if (r[3] > reached) reached = r[3];
      if (reached >= d) break;
    }
    if (reached < d - 1e-9) return false;
  }
  return true;
}

// Is box `m` enclosed by `neighbours` (boxes that may touch it; others are ignored harmlessly)?
export function isEnclosed(m, neighbours) {
  const perms = [];
  for (const n of neighbours) perms.push(alignedPermutation(m, n));
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    for (const sign of [1, -1]) {
      const plane = sign * m.h[i];
      const rects = [];
      for (let ni = 0; ni < neighbours.length; ni++) {
        const perm = perms[ni];
        if (!perm) continue;
        const n = neighbours[ni];
        const offset = [n.c[0] - m.c[0], n.c[1] - m.c[1], n.c[2] - m.c[2]];
        // The neighbour in the placement's own frame (axis a of m is axis perm[a] of n).
        const centre = [dot(offset, m.axes[0]), dot(offset, m.axes[1]), dot(offset, m.axes[2])];
        const half = [n.h[perm[0]], n.h[perm[1]], n.h[perm[2]]];
        const lo = centre[i] - half[i];
        const hi = centre[i] + half[i];
        // On the far side of this face: from the plane out by at least the minimum depth.
        if (sign > 0 ? !(lo <= plane + SEAM_TOLERANCE_M && hi >= plane + MIN_COVER_DEPTH_M) : !(hi >= plane - SEAM_TOLERANCE_M && lo <= plane - MIN_COVER_DEPTH_M)) continue;
        rects.push([centre[j] - half[j], centre[j] + half[j], centre[k] - half[k], centre[k] + half[k]]);
      }
      if (!coversRect(rects, m.h[j] - SEAM_TOLERANCE_M, m.h[k] - SEAM_TOLERANCE_M)) return false;
    }
  }
  return true;
}

// The indices of the enclosed boxes among `boxes`, worked in slices (nothing here may hold a frame).
function cellKeyOf(c, cell) {
  return `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)},${Math.floor(c[2] / cell)}`;
}

const GRID_CHUNK = 256;

export function createEnclosureJob(boxes) {
  let reach = 0;
  for (const b of boxes) reach = Math.max(reach, Math.hypot(b.h[0], b.h[1], b.h[2]));
  const cell = Math.max(reach * 2, 0.1);
  const grid = new Map();
  let gridNext = 0;
  const enclosed = new Set();
  let next = 0;
  const neighbourBoxes = [];
  function visit(index) {
    const b = boxes[index];
    neighbourBoxes.length = 0;
    const cx = Math.floor(b.c[0] / cell); const cy = Math.floor(b.c[1] / cell); const cz = Math.floor(b.c[2] / cell);
    const bReach = Math.hypot(b.h[0], b.h[1], b.h[2]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const other of list) {
        if (other === index) continue;
        const o = boxes[other];
        const gap = Math.hypot(o.c[0] - b.c[0], o.c[1] - b.c[1], o.c[2] - b.c[2]);
        if (gap <= bReach + Math.hypot(o.h[0], o.h[1], o.h[2]) + SEAM_TOLERANCE_M) {
          neighbourBoxes.push(o);
          if (neighbourBoxes.length > MAX_NEIGHBOURS) return; // a pile, not a wall: drawn
        }
      }
    }
    // Fewer than six neighbours cannot cover six faces.
    if (neighbourBoxes.length >= 6 && isEnclosed(b, neighbourBoxes)) enclosed.add(index);
  }
  return {
    get done() { return gridNext >= boxes.length && next >= boxes.length; },
    get enclosed() { return enclosed; },
    // Works until `budgetMs` of `now()` is spent (at least one unit). Returns true when finished.
    step(budgetMs, now = () => performance.now()) {
      const start = now();
      do {
        if (gridNext < boxes.length) {
          const end = Math.min(boxes.length, gridNext + GRID_CHUNK);
          for (; gridNext < end; gridNext++) {
            const key = cellKeyOf(boxes[gridNext].c, cell);
            const list = grid.get(key);
            if (list) list.push(gridNext); else grid.set(key, [gridNext]);
          }
        } else if (next < boxes.length) {
          visit(next++);
        } else return true;
      } while (now() - start < budgetMs);
      return gridNext >= boxes.length && next >= boxes.length;
    },
  };
}

export function findEnclosed(boxes) {
  const job = createEnclosureJob(boxes);
  job.step(Infinity);
  return job.enclosed;
}
