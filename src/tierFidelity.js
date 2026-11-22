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
export const TIER_LIMITS = {
  mid: { minCoverage: 0.88, maxExtra: 0.4 },
  far: { minCoverage: 0.6, maxExtra: 0.5 },
};

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

// { coverage, extra, views } for `tier` against `full`: coverage and extra are the worst of the six views;
// views lists each. A full model that covers nothing (no triangles) is reported as faithful.
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
  return { coverage, extra, views };
}

export function isFaithful(report, tier = 'mid') {
  const { minCoverage, maxExtra } = typeof tier === 'string' ? TIER_LIMITS[tier] : tier;
  return report.coverage >= minCoverage && report.extra <= maxExtra;
}
