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

describe('mergeMemberShell carries colour and shading (#4366 slice 2)', () => {
  it('has a normal, a texture coordinate and a position for every corner it keeps', () => {
    const r = mergeMemberShell(box(), [at(0, 0, 0), at(1, 0, 0)]);
    expect(r.normals.length).toBe(r.triangles * 9);
    expect(r.uvs.length).toBe(r.triangles * 6);
    expect(r.positions.length).toBe(r.triangles * 9);
    expect(r.colors).toBeUndefined(); // a box has no vertex colours
  });

  it('a lone box keeps its own normals and texture coordinates exactly', () => {
    const g = box();
    const r = mergeMemberShell(g, [at(0, 0, 0)]);
    const index = g.index;
    for (let t = 0; t < 12; t++) {
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        expect(r.uvs[(t * 3 + k) * 2]).toBeCloseTo(g.attributes.uv.getX(v), 6);
        expect(r.uvs[(t * 3 + k) * 2 + 1]).toBeCloseTo(g.attributes.uv.getY(v), 6);
        expect(r.normals[(t * 3 + k) * 3]).toBeCloseTo(g.attributes.normal.getX(v), 6);
      }
    }
  });

  it('turns the normals with a turned member and keeps them unit length', () => {
    const turn = new Matrix4().makeRotationZ(Math.PI / 2);
    const r = mergeMemberShell(box(), [turn]);
    for (let i = 0; i < r.normals.length; i += 3) {
      expect(Math.hypot(r.normals[i], r.normals[i + 1], r.normals[i + 2])).toBeCloseTo(1, 5);
    }
    // The +x face of the box is now the +y face: some triangle has the normal (0, 1, 0).
    let found = false;
    for (let i = 0; i < r.normals.length; i += 3) {
      if (Math.abs(r.normals[i + 1] - 1) < 1e-5) found = true;
    }
    expect(found).toBe(true);
  });

  it('a mirrored member still has normals that point outward', () => {
    const mirror = new Matrix4().makeScale(-1, 1, 1);
    const r = mergeMemberShell(box(), [mirror]);
    for (let t = 0; t < r.triangles; t++) {
      const at0 = t * 9;
      // The outward test: the normal agrees with the corner's direction from the box centre along its own axis.
      for (let k = 0; k < 3; k++) {
        const px = r.positions[at0 + k * 3];
        const py = r.positions[at0 + k * 3 + 1];
        const pz = r.positions[at0 + k * 3 + 2];
        const nx = r.normals[at0 + k * 3];
        const ny = r.normals[at0 + k * 3 + 1];
        const nz = r.normals[at0 + k * 3 + 2];
        expect(px * nx + py * ny + pz * nz).toBeGreaterThan(0);
      }
    }
  });

  it('a geometry with no normals or texture coordinates carries none', () => {
    const g = box();
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    const r = mergeMemberShell(g, [at(0, 0, 0)]);
    expect(r.normals).toBeUndefined();
    expect(r.uvs).toBeUndefined();
  });

  it('what was kept still matches the dropped-face rule: the carried arrays follow the positions', () => {
    const wall = [];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) wall.push(at(x, y, 0));
    const r = mergeMemberShell(box(), wall);
    expect(r.normals.length).toBe(r.triangles * 9);
    expect(r.uvs.length).toBe(r.triangles * 6);
  });
});
