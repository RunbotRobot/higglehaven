import { describe, it, expect } from 'vitest';
import { BoxGeometry, Matrix4 } from 'three';
import { mergeMemberShell } from './mergedShell.js';

const at = (x, y, z) => new Matrix4().makeTranslation(x, y, z);
const box = () => new BoxGeometry(1, 1, 1);

describe('mergeMemberShell (#4366 slice 1)', () => {
  it('one member is unchanged', () => {
    const r = mergeMemberShell(box(), [at(0, 0, 0)]);
    expect(r.triangles).toBe(12);
    expect(r.droppedTriangles).toBe(0);
  });

  it('drops the pressed faces of two boxes that touch, in whole pairs', () => {
    const r = mergeMemberShell(box(), [at(0, 0, 0), at(1, 0, 0)]);
    expect(r.inputTriangles).toBe(24);
    // The shared face (two triangles on each box) goes on both sides: 24 - 4.
    expect(r.triangles).toBe(20);
  });

  it('keeps every face of boxes that do not touch', () => {
    const r = mergeMemberShell(box(), [at(0, 0, 0), at(3, 0, 0)]);
    expect(r.triangles).toBe(24);
  });

  it('a wall of boxes on a grid loses its interior and keeps the outside', () => {
    const matrices = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) matrices.push(at(x, y, z));
    const r = mergeMemberShell(box(), matrices);
    expect(r.inputTriangles).toBe(216 * 12);
    // The outside of a 6x6x6 block is 6 sides of 36 squares, two triangles each: exactly 432 remain.
    expect(r.triangles).toBe(432);
  });

  it('never drops a face that has no exact partner (a neighbour shifted by half a unit)', () => {
    const r = mergeMemberShell(box(), [at(0, 0, 0), at(1, 0.5, 0)]);
    expect(r.triangles).toBe(24);
  });

  it('puts the winding right for a mirrored member', () => {
    const mirrored = new Matrix4().makeScale(-1, 1, 1).setPosition(0, 5, 0);
    const r = mergeMemberShell(box(), [mirrored]);
    expect(r.triangles).toBe(12);
    // First triangle's outward direction agrees with its centroid direction from the box centre (0,5,0).
    const p = r.positions;
    const a = [p[0], p[1] - 5, p[2]], b = [p[3], p[4] - 5, p[5]], c = [p[6], p[7] - 5, p[8]];
    const e1 = b.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const centroid = a.map((x, i) => (x + b[i] + c[i]) / 3);
    expect(n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2]).toBeGreaterThan(0);
  });
});
