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
//  4. Every box in the solid must itself fill its box: this is the caller's check on the model (solidFill),
//     made for every version the batch can draw, and a batch that fails it culls nothing.
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
const FILL_MIN = 0.98;
const WELD_M = 1e-5;

// How much of its bounding box a closed model fills, from its triangles (model space, already through the
// part matrices): signed volume over box volume. An open mesh (a hole, a missing face, a vertex shared across
// a seam that does not match) has no volume, and answers { box: false }. positions: flat [x,y,z,...];
// index: flat triangle indices or null for a triangle list.
export function solidFill(positions, index) {
  const count = positions.length / 3;
  if (count < 4) return { box: false, fill: 0 };
  const triangles = index ? index.length / 3 : Math.floor(count / 3);
  if (triangles < 4) return { box: false, fill: 0 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (!Number.isFinite(v)) return { box: false, fill: 0 };
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const boxVolume = size[0] * size[1] * size[2];
  if (!(boxVolume > 0)) return { box: false, fill: 0 };
  // Weld by position so a model with a vertex per face is still one surface.
  const welded = new Map();
  const ids = new Int32Array(count);
  const key = (i) => `${Math.round(positions[i * 3] / WELD_M)},${Math.round(positions[i * 3 + 1] / WELD_M)},${Math.round(positions[i * 3 + 2] / WELD_M)}`;
  for (let i = 0; i < count; i++) {
    const k = key(i);
    let id = welded.get(k);
    if (id === undefined) { id = welded.size; welded.set(k, id); }
    ids[i] = id;
  }
  const edges = new Map(); // "a_b" (a < b) -> signed use count: +1 per direction a->b, -1 per b->a; closed iff each is used once each way
  let volume = 0;
  for (let t = 0; t < triangles; t++) {
    const ia = index ? index[t * 3] : t * 3;
    const ib = index ? index[t * 3 + 1] : t * 3 + 1;
    const ic = index ? index[t * 3 + 2] : t * 3 + 2;
    const a = ids[ia]; const b = ids[ib]; const c = ids[ic];
    if (a === b || b === c || a === c) continue; // a sliver welded to a line: no area
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const forward = from < to;
      const k = forward ? `${from}_${to}` : `${to}_${from}`;
      const entry = edges.get(k) ?? [0, 0];
      entry[forward ? 0 : 1] += 1;
      edges.set(k, entry);
    }
    const ax = positions[ia * 3]; const ay = positions[ia * 3 + 1]; const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3]; const by = positions[ib * 3 + 1]; const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3]; const cy = positions[ic * 3 + 1]; const cz = positions[ic * 3 + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  // Closed and consistently wound: every edge is walked once each way.
  for (const [forward, backward] of edges.values()) if (forward !== 1 || backward !== 1) return { box: false, fill: 0 };
  const fill = volume / boxVolume;
  return { box: fill >= FILL_MIN && fill <= 1 + 1e-6, fill, min, max };
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

// Do the rectangles [x0,x1]x[y0,y1] together cover [-w, w]x[-d, d]? Exact: the plane is cut at every edge
// and each cell is looked up.
function coversRect(rects, w, d) {
  if (w <= 0 || d <= 0) return true;
  const xs = [-w, w];
  const ys = [-d, d];
  for (const r of rects) {
    if (r[0] > -w && r[0] < w) xs.push(r[0]);
    if (r[1] > -w && r[1] < w) xs.push(r[1]);
    if (r[2] > -d && r[2] < d) ys.push(r[2]);
    if (r[3] > -d && r[3] < d) ys.push(r[3]);
  }
  xs.sort((p, q) => p - q);
  ys.sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i + 1] - xs[i] < 1e-9) continue;
    const mx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j + 1 < ys.length; j++) {
      if (ys[j + 1] - ys[j] < 1e-9) continue;
      const my = (ys[j] + ys[j + 1]) / 2;
      let hit = false;
      for (const r of rects) {
        if (mx >= r[0] && mx <= r[1] && my >= r[2] && my <= r[3]) { hit = true; break; }
      }
      if (!hit) return false;
    }
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

// The ids (indices) of the enclosed boxes among `boxes`. Neighbours are found in a hash of cells as wide as
// the biggest box's reach; `budgetMs`/`now` let a caller slice the work (see createEnclosureJob).
function cellKeyOf(c, cell) {
  return `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)},${Math.floor(c[2] / cell)}`;
}

export function createEnclosureJob(boxes) {
  let reach = 0;
  for (const b of boxes) reach = Math.max(reach, Math.hypot(b.h[0], b.h[1], b.h[2]));
  const cell = Math.max(reach * 2, 0.1);
  const grid = new Map();
  boxes.forEach((b, index) => {
    const key = cellKeyOf(b.c, cell);
    const list = grid.get(key);
    if (list) list.push(index); else grid.set(key, [index]);
  });
  const enclosed = new Set();
  let next = 0;
  const neighbourBoxes = [];
  function visit(index) {
    const b = boxes[index];
    neighbourBoxes.length = 0;
    const cx = Math.floor(b.c[0] / cell); const cy = Math.floor(b.c[1] / cell); const cz = Math.floor(b.c[2] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const other of list) {
        if (other === index) continue;
        const o = boxes[other];
        const gap = Math.hypot(o.c[0] - b.c[0], o.c[1] - b.c[1], o.c[2] - b.c[2]);
        if (gap <= Math.hypot(b.h[0], b.h[1], b.h[2]) + Math.hypot(o.h[0], o.h[1], o.h[2]) + SEAM_TOLERANCE_M) neighbourBoxes.push(o);
      }
    }
    // Fewer than six neighbours cannot cover six faces.
    if (neighbourBoxes.length >= 6 && isEnclosed(b, neighbourBoxes)) enclosed.add(index);
  }
  return {
    get done() { return next >= boxes.length; },
    get enclosed() { return enclosed; },
    // Works until `budgetMs` of `now()` is spent (at least one box). Returns true when finished.
    step(budgetMs, now = () => performance.now()) {
      const start = now();
      do {
        if (next >= boxes.length) return true;
        visit(next++);
      } while (now() - start < budgetMs);
      return next >= boxes.length;
    },
  };
}

export function findEnclosed(boxes) {
  const job = createEnclosureJob(boxes);
  job.step(Infinity);
  return job.enclosed;
}
