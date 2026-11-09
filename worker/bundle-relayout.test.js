import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { findPlacementTransform, layOutItems, unyawItems } from './lib/bundle-relayout.js';

// A small wall: three bricks and a door, with a tilted member to exercise the
// orientation maths.
const items = [
  { templateId: 'brick', dx: -1, dy: 0, dz: 0.1, rotationX: 0, rotationY: 0, rotationZ: 0, crop: {}, scale: 1 },
  { templateId: 'brick', dx: 1, dy: 0, dz: 0.1, rotationX: 0, rotationY: 0, rotationZ: 0, crop: {}, scale: 1 },
  { templateId: 'brick', dx: 0, dy: 0, dz: 0.4, rotationX: 0.2, rotationY: 0.1, rotationZ: 0.3, crop: {}, scale: 1 },
  { templateId: 'door', dx: 0, dy: 1.5, dz: 1, rotationX: 0, rotationY: 0, rotationZ: 0, crop: {}, scale: 2 },
];

// What the Build scene does to a placement: translate it and turn it about z.
function place(list, theta, tx, ty, tz) {
  return layOutItems(list, { theta, tx, ty, tz }).map((row, index) => ({ id: `r${index}`, ...row }));
}

describe('findPlacementTransform', () => {
  it('recovers the yaw and translation of an untouched placement', () => {
    const rows = place(items, 1.1, 20, -5, 3);
    const found = findPlacementTransform(items, rows);
    expect(found).not.toBeNull();
    expect(found.theta).toBeCloseTo(1.1, 6);
    expect(found.tx).toBeCloseTo(20, 6);
    expect(found.ty).toBeCloseTo(-5, 6);
    expect(found.tz).toBeCloseTo(3, 6);
    expect(found.pairs.size).toBe(items.length);
  });

  it('matches symmetric members correctly (mirror bricks are interchangeable)', () => {
    const rows = place(items, Math.PI, 0, 0, 0).reverse();
    const found = findPlacementTransform(items, rows);
    expect(found.theta).toBeCloseTo(Math.PI, 5);
  });

  it('agrees with three.js on the rigid turn the Build scene applies', () => {
    const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
    const rows = items.map((item, i) => {
      const p = new THREE.Vector3(item.dx, item.dy, item.dz).applyQuaternion(delta);
      const q = delta.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(item.rotationX, item.rotationY, item.rotationZ)));
      const e = new THREE.Euler().setFromQuaternion(q);
      return { id: `r${i}`, templateId: item.templateId, x: p.x + 4, y: p.y + 9, z: p.z, rotationX: e.x, rotationY: e.y, rotationZ: e.z, scale: item.scale };
    });
    const found = findPlacementTransform(items, rows);
    expect(found.theta).toBeCloseTo(0.7, 6);
  });

  it('refuses a placement whose member was moved by hand', () => {
    const rows = place(items, 0.4, 1, 2, 0);
    rows[1].x += 0.5;
    expect(findPlacementTransform(items, rows)).toBeNull();
  });

  it('refuses a placement with a member missing or tilted about a horizontal axis', () => {
    expect(findPlacementTransform(items, place(items, 0, 0, 0, 0).slice(1))).toBeNull();
    const tilted = place(items, 0, 0, 0, 0).map((row) => ({ ...row, rotationX: row.rotationX + 0.5 }));
    expect(findPlacementTransform(items, tilted)).toBeNull();
  });
});

describe('layOutItems / unyawItems', () => {
  it('keeps each placement own anchor and yaw when the members change', () => {
    const edited = items.map((item, i) => (i === 1 ? { ...item, dx: 2 } : item));
    const rows = place(items, 0.9, 7, 8, 1);
    const found = findPlacementTransform(items, rows);
    const relaid = layOutItems(edited, found);
    const expected = layOutItems(edited, { theta: 0.9, tx: 7, ty: 8, tz: 1 });
    relaid.forEach((row, i) => {
      expect(row.x).toBeCloseTo(expected[i].x, 9);
      expect(row.y).toBeCloseTo(expected[i].y, 9);
      expect(row.z).toBeCloseTo(expected[i].z, 9);
    });
  });

  it('unyawItems puts a turned copy back into the template frame', () => {
    const turned = unyawItems(items, 0.6);
    const back = unyawItems(turned, -0.6);
    back.forEach((item, i) => {
      expect(item.dx).toBeCloseTo(items[i].dx, 9);
      expect(item.dy).toBeCloseTo(items[i].dy, 9);
      const a = new THREE.Quaternion().setFromEuler(new THREE.Euler(item.rotationX, item.rotationY, item.rotationZ));
      const b = new THREE.Quaternion().setFromEuler(new THREE.Euler(items[i].rotationX, items[i].rotationY, items[i].rotationZ));
      expect(Math.abs(a.dot(b))).toBeGreaterThan(1 - 1e-9);
    });
  });
});
