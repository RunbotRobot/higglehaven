// #4062: is a simpler version of a model still the model? A product's mid and far versions
// (src/modelTiers.js) are meant to read as the same thing from further away; "Everything built is
// always shown as itself". The owner's brick wall showed what happens when nothing checks it: the far
// version of a 5,320-triangle scan had 50 single-sided triangles and, from the six axes, covered 0 to
// 36% of what the full model covers (a see-through net), and the mid version had holes (74 to 92%).
//
// The check is the silhouette from the six axes: draw the full model and the simpler version as the
// viewer sees them (a single-sided material shows only faces turned toward the viewer; a double-sided
// one shows both) onto a small grid, and compare. Fidelity is how much of what the full model covers the
// simpler one also covers (the worst of the six views), and how much it covers that the full model does
// not (the worst of the six, as a fraction of the full model's coverage).
//
// Pure maths on flat triangle lists, so the same check runs in the browser at upload, in node for the
// backfill, and in the scan over the live catalogue (scripts/scan-model-tiers.mjs) with no three.js.
//
// A "batch" is { positions: Float32Array (nine numbers per triangle, in the model's own root space),
// doubleSided: boolean }; a model is an array of batches (one per mesh).

export const FIDELITY_GRID = 64;
// A simpler version must cover at least this much of what the full model covers, in every view, and may
// cover at most this much extra (as a fraction of the full model's coverage). Mid is seen at middle
// distance and must read as the model, holes and all; far is a few dozen triangles seen small, so it is
// held to "this is the model, not a net": the owner's brick far version covered 0 to 36% and its mid
// version 73%, where a sound far version of a smooth shape covers about 65 to 95%.
//
// #4111 (the owner: a person "shouldn't be seeing a difference between the two objects"): far was 0.6 and 0.5, which
// passed a door covering 67% of itself (torn, with its lower corner gone: pixel difference 0.38 at the size where it
// is swapped in) and an outline that filled in the gap between a toilet's tank and bowl. Measured on the live
// catalogue with scripts/render-model-tiers.mjs --regenerate: at 0.9 and 0.25 the door becomes a 20-triangle box
// (pixel difference 0.05, was 0.38), the white wall 48 triangles (0.025, was 0.12) and the tree its own 448 (0.006,
// was 0.31); at 0.8 the toilet and the wall went back to their poor versions. Thresholds are a first reading of
// "cannot be told apart", tuned on nine models.
//
// #4114: the outline alone passed a brick whose mid version had lost 12% of its surface (0.91 coverage:
// "nine percent of the outline missing is a pass") and showed jagged, torn faces from two metres. A mid
// version is also held to keep its surface (minAreaKept: the area of its triangles over the full model's)
// and not to open holes the full model does not have (maxOpenGrowth: the length of its open edges over the
// full model's, where an open edge belongs to one triangle only, positions welded). A far version is a few
// dozen triangles meant to read as an outline, so neither applies to it.
export const TIER_LIMITS = {
  mid: { minCoverage: 0.95, maxExtra: 0.4, minAreaKept: 0.95, maxOpenGrowth: 1.15 },
  far: { minCoverage: 0.9, maxExtra: 0.25 },
};
// #4111: the far limits above are for the cheap versions (the usual far budget, the model's outline). One heavier
// version (three times the budget) is tried only after both failed, and is held to a little less coverage, because a
// smooth shape simplified to a third of its triangles covers about 87% of its own outline, not 90.
// Its colour limit is a little looser too: a version that keeps 86% of its area has the colour of its parts weighted by
// the area it kept, so a model of three colours moves by about 0.10 (a box, a sphere and a cylinder, in the tests).
export const FAR_HEAVIER_LIMITS = { minCoverage: 0.8, maxExtra: 0.25, maxColorShift: 0.12 };

// Triangle batches' shared bounds, so both models are drawn on the same grid.
export function boundsOfBatches(batches) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of batches) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return { min, max };
}

// #4114: the surface area of a model's triangles and the total length of its open edges (an edge used by one
// triangle only, vertices welded within a hundred-thousandth of the model's own size). A closed model has no
// open edges; a patchwork of pieces has many, and shrinking a piece's border shrinks both numbers.
export function surfaceStats(batches) {
  const bounds = boundsOfBatches(batches);
  const diagonal = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const cell = Math.max((Number.isFinite(diagonal) ? diagonal : 0) * 1e-5, 1e-9);
  const ids = new Map();
  const idOf = (x, y, z) => {
    const key = `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    return id;
  };
  const edges = new Map();
  let area = 0;
  for (const { positions } of batches) {
    for (let t = 0; t + 8 < positions.length; t += 9) {
      const a = idOf(positions[t], positions[t + 1], positions[t + 2]);
      const b = idOf(positions[t + 3], positions[t + 4], positions[t + 5]);
      const c = idOf(positions[t + 6], positions[t + 7], positions[t + 8]);
      if (a === b || b === c || a === c) continue; // a triangle with no area
      const ux = positions[t + 3] - positions[t];
      const uy = positions[t + 4] - positions[t + 1];
      const uz = positions[t + 5] - positions[t + 2];
      const vx = positions[t + 6] - positions[t];
      const vy = positions[t + 7] - positions[t + 1];
      const vz = positions[t + 8] - positions[t + 2];
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      const corners = [[a, b, t, t + 3], [b, c, t + 3, t + 6], [c, a, t + 6, t]];
      for (const [x, y, p, q] of corners) {
        const key = x < y ? `${x}-${y}` : `${y}-${x}`;
        const entry = edges.get(key);
        if (entry) entry.n++;
        else edges.set(key, { n: 1, length: Math.hypot(positions[p] - positions[q], positions[p + 1] - positions[q + 1], positions[p + 2] - positions[q + 2]) });
      }
    }
  }
  let openEdgeLength = 0;
  for (const { n, length } of edges.values()) if (n === 1) openEdgeLength += length;
  return { area, openEdgeLength };
}

// One view: the viewer is on the `sign` side of `axis`, looking along it.
function rasterize(batches, axis, sign, bounds, grid) {
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  const cells = new Uint8Array(grid * grid);
  const spanA = Math.max(bounds.max[a] - bounds.min[a], 1e-12);
  const spanB = Math.max(bounds.max[b] - bounds.min[b], 1e-12);
  const scaleA = (grid - 1) / spanA;
  const scaleB = (grid - 1) / spanB;
  for (const { positions, doubleSided } of batches) {
    for (let t = 0; t + 8 < positions.length; t += 9) {
      const ux = positions[t + 3] - positions[t];
      const uy = positions[t + 4] - positions[t + 1];
      const uz = positions[t + 5] - positions[t + 2];
      const vx = positions[t + 6] - positions[t];
      const vy = positions[t + 7] - positions[t + 1];
      const vz = positions[t + 8] - positions[t + 2];
      const normal = axis === 0 ? uy * vz - uz * vy : axis === 1 ? uz * vx - ux * vz : ux * vy - uy * vx;
      if (!doubleSided && normal * sign <= 0) continue; // a back face is not drawn
      const pa = [0, 1, 2].map((i) => (positions[t + 3 * i + a] - bounds.min[a]) * scaleA);
      const pb = [0, 1, 2].map((i) => (positions[t + 3 * i + b] - bounds.min[b]) * scaleB);
      const x0 = Math.max(0, Math.floor(Math.min(pa[0], pa[1], pa[2])));
      const x1 = Math.min(grid - 1, Math.ceil(Math.max(pa[0], pa[1], pa[2])));
      const y0 = Math.max(0, Math.floor(Math.min(pb[0], pb[1], pb[2])));
      const y1 = Math.min(grid - 1, Math.ceil(Math.max(pb[0], pb[1], pb[2])));
      const d = (pb[1] - pb[2]) * (pa[0] - pa[2]) + (pa[2] - pa[1]) * (pb[0] - pb[2]);
      if (Math.abs(d) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const l1 = ((pb[1] - pb[2]) * (x - pa[2]) + (pa[2] - pa[1]) * (y - pb[2])) / d;
          const l2 = ((pb[2] - pb[0]) * (x - pa[2]) + (pa[0] - pa[2]) * (y - pb[2])) / d;
          const l3 = 1 - l1 - l2;
          if (l1 >= -0.02 && l2 >= -0.02 && l3 >= -0.02) cells[y * grid + x] = 1;
        }
      }
    }
  }
  return cells;
}

// { coverage, extra, views, areaKept, openGrowth } for `tier` against `full`: coverage and extra are the worst
// of the six views; views lists each; areaKept is the tier's surface over the full model's (#4114) and
// openGrowth the length of its open edges over the full model's, plus the one grid cell of slack a model with
// none needs. A full model that covers nothing (no triangles) is reported as faithful.
export function silhouetteFidelity(full, tier, grid = FIDELITY_GRID) {
  const bounds = boundsOfBatches([...full, ...tier]); // a version that grew past the model shows as extra, not as clipped
  const views = [];
  let coverage = 1;
  let extra = 0;
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      const ref = rasterize(full, axis, sign, bounds, grid);
      const got = rasterize(tier, axis, sign, bounds, grid);
      let refCount = 0;
      let both = 0;
      let only = 0;
      for (let i = 0; i < ref.length; i++) {
        if (ref[i]) refCount++;
        if (ref[i] && got[i]) both++;
        else if (got[i]) only++;
      }
      if (refCount === 0) continue;
      const view = { axis, sign, coverage: both / refCount, extra: only / refCount };
      views.push(view);
      coverage = Math.min(coverage, view.coverage);
      extra = Math.max(extra, view.extra);
    }
  }
  const fullSurface = surfaceStats(full);
  const tierSurface = surfaceStats(tier);
  const areaKept = fullSurface.area > 0 ? tierSurface.area / fullSurface.area : 1;
  const span = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  // A closed full model has no open edges at all: any open edge on the version is then a hole it tore, measured
  // against a few percent of the model's own size so a hair of welding noise is not a verdict.
  const openGrowth = (tierSurface.openEdgeLength + 0.02 * span) / (fullSurface.openEdgeLength + 0.02 * span);
  return { coverage, extra, views, areaKept, openGrowth, colorShift: colorShift(full, tier) };
}

// #4111: colour. A batch may carry `color` ([r, g, b], linear, what the batch looks like lit) and `area`
// (its triangles' total area). A toilet of dark grey passed the outline check above while its far
// version was white, so the version a person sees from further away must also be the same colour.
// The shift is the largest difference in any channel, in sRGB (0 to 1), between the area-weighted mean
// colours of the model and of the version; null when either side carries no colour (an old caller).
export const COLOR_SHIFT_LIMIT = { mid: 0.08, far: 0.1 };

function toSrgb(c) {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// #4111 (the Door the scan failed on colour, 2026-11-26): the mean colour is the area-weighted mean over the batches
// that carry a colour. A reader that cannot read a texture (scripts/glb-batches-lib.mjs decodes no images) gives a
// textured batch none, so a model of nine textured batches and one small plain white one was "white": the scan
// compared the far version's real colour with the white of 0.3% of the surface and reported a shift of 0.53, while
// the generator, which reads every texture, had made the far version rightly. When the batches with no colour
// hold more than this share of the surface, the colour of the whole is not known and none is returned: no colour
// to compare, not a wrong one.
export const MAX_UNCOLORED_AREA_SHARE = 0.25;

export function meanBatchColor(batches) {
  let area = 0;
  let uncolored = 0;
  const sum = [0, 0, 0];
  for (const batch of batches) {
    if (!(batch.area > 0)) continue;
    if (!batch.color) {
      uncolored += batch.area;
      continue;
    }
    area += batch.area;
    for (let k = 0; k < 3; k++) sum[k] += batch.color[k] * batch.area;
  }
  if (!(area > 0) || uncolored > MAX_UNCOLORED_AREA_SHARE * (area + uncolored)) return null;
  return sum.map((v) => v / area);
}

export function colorShift(full, tier) {
  const a = meanBatchColor(full);
  const b = meanBatchColor(tier);
  if (!a || !b) return null;
  let shift = 0;
  for (let k = 0; k < 3; k++) shift = Math.max(shift, Math.abs(toSrgb(a[k]) - toSrgb(b[k])));
  return shift;
}

export function isFaithful(report, tier = 'mid') {
  const limits = typeof tier === 'string' ? TIER_LIMITS[tier] : tier;
  const { minCoverage, maxExtra, minAreaKept, maxOpenGrowth } = limits;
  const maxShift = limits.maxColorShift ?? (tier === 'far' ? COLOR_SHIFT_LIMIT.far : COLOR_SHIFT_LIMIT.mid);
  if (report.colorShift != null && report.colorShift > maxShift) return false;
  if (report.coverage < minCoverage || report.extra > maxExtra) return false;
  // #4114: the surface checks, where the tier asks for them and the report carries them.
  if (minAreaKept !== undefined && report.areaKept !== undefined && report.areaKept < minAreaKept) return false;
  if (maxOpenGrowth !== undefined && report.openGrowth !== undefined && report.openGrowth > maxOpenGrowth) return false;
  return true;
}

// #4111: the kind of material a version is drawn with. A model of unlit materials (KHR_materials_unlit) is drawn
// without light, and so must its simpler versions be: a lit far version of an unlit brick was darkened by the
// scene's light and read as a different colour even where its baked colours matched. A batch carries
// `unlit: true` when its material is unlit; a model is unlit when every batch is. Returns null when the kinds
// agree (or either side has no batches), else a sentence for a report.
export function materialKindProblem(full, tier) {
  if (!full.length || !tier.length) return null;
  const unlit = (batches) => batches.every((batch) => batch.unlit === true);
  const fullUnlit = unlit(full);
  const tierUnlit = unlit(tier);
  if (fullUnlit === tierUnlit) return null;
  return fullUnlit ? 'the model is drawn unlit, this version is lit' : 'the model is lit, this version is unlit';
}
