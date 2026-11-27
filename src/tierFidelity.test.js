import { describe, it, expect } from 'vitest';
import { silhouetteFidelity, isFaithful, boundsOfBatches, surfaceStats, materialKindProblem, meanBatchColor, FAR_HEAVIER_LIMITS } from './tierFidelity.js';

// A unit cube as twelve triangles with outward-facing (counter-clockwise from outside) windings.
function cube(scale = 1, doubleSided = false, flip = false) {
  const s = scale / 2;
  const v = [[-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s], [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]];
  const faces = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  const out = [];
  for (const f of faces) for (const i of (flip ? [f[0], f[2], f[1]] : f)) out.push(...v[i]);
  return [{ positions: new Float32Array(out), doubleSided }];
}

describe('silhouetteFidelity (#4062)', () => {
  it('a model is faithful to itself', () => {
    const report = silhouetteFidelity(cube(), cube());
    expect(report.coverage).toBeCloseTo(1, 5);
    expect(report.extra).toBeCloseTo(0, 5);
    expect(isFaithful(report, 'mid')).toBe(true);
    expect(isFaithful(report, 'far')).toBe(true);
  });

  // An open surface (a sheet of two triangles) seen from both sides: turned inside out and single-sided,
  // it vanishes from the side that used to show it; drawing both sides brings it back.
  const sheet = (flip, doubleSided) => [{ positions: new Float32Array(flip ? [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0] : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0]), doubleSided }];

  it('an open version with its faces turned the wrong way disappears from one side when it is single-sided', () => {
    const report = silhouetteFidelity(sheet(false, false), sheet(true, false));
    expect(report.coverage).toBeLessThan(0.1);
    expect(isFaithful(report, 'far')).toBe(false);
  });

  it('the same version is whole when it draws both sides', () => {
    const report = silhouetteFidelity(sheet(false, false), sheet(true, true));
    expect(report.coverage).toBeGreaterThan(0.98);
  });

  it('a version missing most of its triangles is not faithful, even to the far bar', () => {
    const full = cube();
    const net = [{ positions: full[0].positions.slice(0, 9 * 2), doubleSided: true }]; // two of the twelve triangles
    const report = silhouetteFidelity(full, net);
    expect(isFaithful(report, 'far')).toBe(false);
    expect(isFaithful(report, 'mid')).toBe(false);
  });

  it('a version that grows far past the model is not faithful', () => {
    const report = silhouetteFidelity(cube(1), cube(2));
    expect(report.extra).toBeGreaterThan(0.5);
    expect(isFaithful(report, 'mid')).toBe(false);
  });

  it('a slightly shrunken version still passes the mid bar and a model with no triangles is trivially faithful', () => {
    expect(isFaithful(silhouetteFidelity(cube(), cube(0.98)), 'mid')).toBe(true);
    expect(isFaithful(silhouetteFidelity([], []), 'mid')).toBe(true);
  });

  it('boundsOfBatches spans every batch', () => {
    const { min, max } = boundsOfBatches([...cube(1), ...cube(3)]);
    expect(min).toEqual([-1.5, -1.5, -1.5]);
    expect(max).toEqual([1.5, 1.5, 1.5]);
  });
});

describe('colour (#4111)', () => {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const batch = (color) => ({ positions: tri, doubleSided: true, area: 0.5, color });
  const report = (a, b) => silhouetteFidelity([batch(a)], [batch(b)]);

  it('reports no shift when a side carries no colour', () => {
    expect(silhouetteFidelity([{ positions: tri, doubleSided: true }], [batch([1, 1, 1])]).colorShift).toBeNull();
  });

  it('rejects a version that is a different colour although its outline matches (a dark grey model drawn white)', () => {
    const dark = [0.05, 0.05, 0.05];
    expect(isFaithful(report(dark, [0.9, 0.9, 0.9]), 'far')).toBe(false);
    expect(isFaithful(report(dark, [0.9, 0.9, 0.9]), 'mid')).toBe(false);
  });

  it('accepts the same colour', () => {
    expect(isFaithful(report([0.2, 0.3, 0.1], [0.2, 0.3, 0.1]), 'far')).toBe(true);
  });
});

describe('surface checks (#4114)', () => {
  it('surfaceStats measures area and open edge length; a closed cube has no open edges', () => {
    const closed = surfaceStats(cube());
    expect(closed.area).toBeCloseTo(6, 5);
    expect(closed.openEdgeLength).toBe(0);
    const open = surfaceStats([{ positions: cube()[0].positions.slice(0, 9 * 10), doubleSided: false }]);
    expect(open.openEdgeLength).toBeGreaterThan(0);
  });

  it('a version that keeps the outline but loses surface fails the mid bar', () => {
    const report = silhouetteFidelity(cube(), cube(0.9));
    expect(report.areaKept).toBeCloseTo(0.81, 2);
    expect(isFaithful(report, 'mid')).toBe(false);
  });

  it('a version torn open where the model was closed fails the mid bar', () => {
    const torn = [{ positions: cube()[0].positions.slice(0, 9 * 11), doubleSided: false }];
    const report = silhouetteFidelity(cube(), torn);
    expect(report.openGrowth).toBeGreaterThan(1.15);
    expect(isFaithful(report, 'mid')).toBe(false);
  });
});

describe('material kind (#4111)', () => {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const batch = (unlit) => ({ positions: tri, doubleSided: true, unlit });
  it('is fine when both are unlit or both lit', () => {
    expect(materialKindProblem([batch(true)], [batch(true)])).toBeNull();
    expect(materialKindProblem([batch(false)], [batch(false)])).toBeNull();
  });
  it('names a lit version of an unlit model, and the reverse', () => {
    expect(materialKindProblem([batch(true)], [batch(false)])).toMatch(/unlit, this version is lit/);
    expect(materialKindProblem([batch(false)], [batch(true)])).toMatch(/lit, this version is unlit/);
  });
  it('gives no verdict with nothing to compare', () => {
    expect(materialKindProblem([], [batch(true)])).toBeNull();
  });
});

// #4111: a reader that cannot decode textures gives a textured batch no colour; the few batches that do carry one
// must not stand in for the whole model (the Door: nine textured batches, one small plain white one).
describe('meanBatchColor with batches of no colour (#4111)', () => {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  it('is null when most of the surface has no colour, so the colour check has nothing wrong to compare', () => {
    const batches = [
      { positions: tri, area: 9.7 }, // textured, unreadable
      { positions: tri, area: 0.025, color: [1, 1, 1] },
    ];
    expect(meanBatchColor(batches)).toBeNull();
    const far = [{ positions: tri, area: 3.9, color: [0.2, 0.1, 0.05] }];
    expect(silhouetteFidelity(batches, far).colorShift).toBeNull();
  });
  it('still averages the batches that carry a colour when a small share of the surface has none', () => {
    const mean = meanBatchColor([
      { positions: tri, area: 9, color: [0.5, 0.5, 0.5] },
      { positions: tri, area: 0.5 },
    ]);
    expect(mean[0]).toBeCloseTo(0.5, 5);
  });
  it('is null with no coloured batch at all', () => {
    expect(meanBatchColor([{ positions: tri, area: 1 }])).toBeNull();
  });
});

// #4111: the far limits. A far version that covers 67% of the model (the live door: its lower corner gone, a pixel
// difference of 0.38 where it is swapped in) or fills in a quarter of the outline again (a toilet's tank and bowl) is
// a version a person can tell from the model, so it does not pass; one heavier version is held to a little less.
describe('far limits (#4111)', () => {
  const report = (coverage, extra) => ({ coverage, extra });
  it('refuses a version that covers a third less of the outline than the model', () => {
    expect(isFaithful(report(0.67, 0.05), 'far')).toBe(false);
  });
  it('refuses an outline that covers an extra third of the model (the gap between tank and bowl filled in)', () => {
    expect(isFaithful(report(1, 0.34), 'far')).toBe(false);
  });
  it('accepts a version that covers nine tenths and adds a fifth', () => {
    expect(isFaithful(report(0.92, 0.2), 'far')).toBe(true);
  });
  it('holds the one heavier version to eight tenths: a third of a sphere\'s triangles cover about 87%', () => {
    expect(isFaithful(report(0.87, 0.01), FAR_HEAVIER_LIMITS)).toBe(true);
    expect(isFaithful(report(0.87, 0.01), 'far')).toBe(false);
    expect(isFaithful(report(0.75, 0.01), FAR_HEAVIER_LIMITS)).toBe(false);
  });
});
