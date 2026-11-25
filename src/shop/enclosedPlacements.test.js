// #4365: the rule for which placements of a batch are enclosed (src/shop/enclosedPlacements.js).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { solidFill, createSolidFillJob, placementBox, isEnclosed, findEnclosed, createEnclosureJob, MAX_NEIGHBOURS } from './enclosedPlacements.js';

const BOUNDS_MIN = [-0.25, -0.25, 0];
const BOUNDS_MAX = [0.25, 0.25, 0.5];
const LEN = 0.5; // a brick 0.5 m on a side

function boxAt(x, y, z, rotZ = 0, scale = 1) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rotZ)), new THREE.Vector3(scale, scale, scale));
  return placementBox(m.elements, BOUNDS_MIN, BOUNDS_MAX);
}

// A solid block of n x n x n bricks, optionally every other course shifted half a brick in x (running bond).
function block(n, { bond = false, gap = 0 } = {}) {
  const boxes = [];
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    boxes.push(boxAt(x * (LEN + gap) + (bond && z % 2 ? LEN / 2 : 0), y * (LEN + gap), z * (LEN + gap)));
  }
  return boxes;
}
const indexOf = (n, x, y, z) => x + n * (y + n * z);

describe('findEnclosed', () => {
  it('culls only the inside of a solid block', () => {
    const boxes = block(5);
    const enclosed = findEnclosed(boxes);
    expect(enclosed.size).toBe(27); // 3 x 3 x 3 inside a 5 x 5 x 5
    for (let z = 0; z < 5; z++) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const inside = x > 0 && x < 4 && y > 0 && y < 4 && z > 0 && z < 4;
      expect(enclosed.has(indexOf(5, x, y, z))).toBe(inside);
    }
  });

  it('never culls a face brick, an edge brick or a corner brick, and nothing in a block too thin to have an inside', () => {
    expect(findEnclosed(block(2)).size).toBe(0);
    expect(findEnclosed(block(3)).size).toBe(1); // only the centre
    const wall = [];
    for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) wall.push(boxAt(x * LEN, 0, z * LEN));
    expect(findEnclosed(wall).size).toBe(0); // one brick deep: every brick has an outside
  });

  it('culls the inside of a running bond (each side face covered by two bricks half a brick apart)', () => {
    const boxes = block(6, { bond: true });
    const enclosed = findEnclosed(boxes);
    expect(enclosed.size).toBeGreaterThan(0);
    // The top and bottom courses and the outer ring are never enclosed.
    for (let z = 0; z < 6; z++) for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
      if (z === 0 || z === 5 || y === 0 || y === 5) expect(enclosed.has(indexOf(6, x, y, z))).toBe(false);
    }
  });

  it('draws a brick whose neighbour is a hair off its place or turned a little', () => {
    const boxes = block(3);
    const centre = indexOf(3, 1, 1, 1);
    const move = (dx, dy, dz) => {
      const copy = block(3);
      copy[indexOf(3, 2, 1, 1)] = boxAt(2 * LEN + dx, LEN + dy, LEN + dz);
      return copy;
    };
    expect(findEnclosed(boxes).has(centre)).toBe(true);
    expect(findEnclosed(move(0.001, 0, 0)).has(centre)).toBe(true); // a 1 mm seam is inside the tolerance
    expect(findEnclosed(move(0.01, 0, 0)).has(centre)).toBe(false); // a 1 cm crack is not
    expect(findEnclosed(move(0, 0.26, 0)).has(centre)).toBe(false); // slid half a brick: its face is half covered
    const turned = block(3);
    turned[indexOf(3, 2, 1, 1)] = boxAt(2 * LEN, LEN, LEN, 0.0035); // 0.2 degrees
    expect(findEnclosed(turned).has(centre)).toBe(false);
    const turnedQuarter = block(3);
    turnedQuarter[indexOf(3, 2, 1, 1)] = boxAt(2 * LEN, LEN, LEN, Math.PI / 2); // a quarter turn of a square brick is the same brick
    expect(findEnclosed(turnedQuarter).has(centre)).toBe(true);
  });

  it('draws a brick with a missing neighbour (a hole is not covered)', () => {
    const boxes = block(3);
    boxes.splice(indexOf(3, 1, 1, 2), 1); // the top of the centre brick
    expect(findEnclosed(boxes).has(indexOf(3, 1, 1, 1))).toBe(false);
  });

  it('is not fooled by a neighbour of another size that leaves a corner of the face open', () => {
    const boxes = block(3);
    const centre = indexOf(3, 1, 1, 1);
    // A half-size neighbour above covers a quarter of the top face and nothing more.
    boxes[indexOf(3, 1, 1, 2)] = boxAt(LEN, LEN, 2 * LEN, 0, 0.5);
    expect(findEnclosed(boxes).has(centre)).toBe(false);
  });

  it('works for a whole block turned to any angle, and for bricks scaled alike', () => {
    for (const angle of [0.4, 1.1, 2.9]) {
      const rotate = (b) => {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
        const c = new THREE.Vector3(...b.c).applyQuaternion(q);
        return { c: [c.x, c.y, c.z], axes: b.axes.map((a) => { const v = new THREE.Vector3(...a).applyQuaternion(q); return [v.x, v.y, v.z]; }), h: b.h };
      };
      expect(findEnclosed(block(4).map(rotate)).size).toBe(8);
    }
    const scaled = [];
    for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) scaled.push(boxAt(x * LEN * 2, y * LEN * 2, z * LEN * 2, 0, 2));
    expect(findEnclosed(scaled).size).toBe(1);
  });

  it('is the same however the placements are ordered', () => {
    const boxes = block(4, { bond: true });
    const a = findEnclosed(boxes);
    const reversed = boxes.slice().reverse();
    const b = findEnclosed(reversed);
    expect(b.size).toBe(a.size);
    for (const i of a) expect(b.has(boxes.length - 1 - i)).toBe(true);
  });

  it('can be worked in slices and answers the same', () => {
    const boxes = block(5);
    const job = createEnclosureJob(boxes);
    let calls = 0;
    let t = 0;
    while (!job.step(1, () => (t += 0.6))) calls++;
    expect(calls).toBeGreaterThan(5);
    expect([...job.enclosed].sort((p, q) => p - q)).toEqual([...findEnclosed(boxes)].sort((p, q) => p - q));
  });

  it('answers a thousand bricks well inside a frame', () => {
    const boxes = block(11, { bond: true });
    const start = performance.now();
    findEnclosed(boxes);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('isEnclosed', () => {
  it('needs the neighbour to stand beyond the face, not just overlap it', () => {
    const m = boxAt(0, 0, 0);
    const thin = [1, -1].flatMap((s) => [boxAt(s * LEN, 0, 0), boxAt(0, s * LEN, 0), boxAt(0, 0, s * LEN)]);
    expect(isEnclosed(m, thin)).toBe(true);
    // The same six, but the one above sits where the brick itself is: it reaches the top face from inside and
    // stands nowhere beyond it, so it hides nothing.
    const sunk = thin.slice();
    sunk[2] = boxAt(0, 0, 0);
    expect(isEnclosed(m, sunk)).toBe(false);
  });
});

// Builds a closed box (or a box with a face missing) as flat position / index arrays.
function boxMesh({ size = [1, 1, 1], skip = -1, flip = false, hole = false } = {}) {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const position = Array.from(g.attributes.position.array);
  let index = Array.from(g.index.array);
  if (skip >= 0) index = index.filter((_, i) => Math.floor(i / 6) !== skip); // 6 indices per face
  if (hole) index = index.slice(3); // one triangle gone
  if (flip) for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  return { position, index };
}

describe('solidFill', () => {
  it('calls a closed box a box, and a vertex-per-face model too (BoxGeometry has one)', () => {
    const { position, index } = boxMesh({ size: [0.5, 0.5, 0.5] });
    const verdict = solidFill(position, index);
    expect(verdict.box).toBe(true);
    expect(verdict.fill).toBeCloseTo(1, 6);
    // The same as a plain triangle list with no index.
    const flat = [];
    for (const i of index) flat.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
    expect(solidFill(flat, null).box).toBe(true);
  });

  it('refuses a model that is open, wound the wrong way, or not a box', () => {
    expect(solidFill(...Object.values(boxMesh({ skip: 2 }))).box).toBe(false);
    expect(solidFill(...Object.values(boxMesh({ hole: true }))).box).toBe(false);
    expect(solidFill(...Object.values(boxMesh({ flip: true }))).box).toBe(false);
    const sphere = new THREE.IcosahedronGeometry(0.25, 4).toNonIndexed();
    const verdict = solidFill(Array.from(sphere.attributes.position.array), null);
    expect(verdict.box).toBe(false);
    expect(solidFill([], null).box).toBe(false);
  });

  it('allows a plain closed box of any size', () => {
    const verdict = solidFill(...Object.values(boxMesh({ size: [2, 0.3, 0.7] })));
    expect(verdict.box).toBe(true);
    expect(verdict.min).toEqual([-1, -0.15, -0.35].map((v) => expect.closeTo(v, 6)));
  });
});

// A closed 1 m box with a square tunnel of half-width `a` through it (z), as flat arrays.
function boxWithTunnel(a) {
  const ring = (h, z) => [[h, h], [-h, h], [-h, -h], [h, -h]].map(([x, y]) => [x, y, z]);
  const positions = [];
  const indices = [];
  const add = (points) => points.map((p) => { positions.push(...p); return positions.length / 3 - 1; });
  const ot = add(ring(0.5, 0.5)); const ob = add(ring(0.5, -0.5)); const it = add(ring(a, 0.5)); const ib = add(ring(a, -0.5));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    indices.push(ot[i], ot[j], it[j], ot[i], it[j], it[i]); // top, facing up
    indices.push(ob[j], ob[i], ib[i], ob[j], ib[i], ib[j]); // bottom, facing down
    indices.push(ob[i], ob[j], ot[j], ob[i], ot[j], ot[i]); // outer side, facing out
    indices.push(ib[j], ib[i], it[i], ib[j], it[i], it[j]); // tunnel wall, facing the hole
  }
  return { position: positions, index: indices };
}

describe('solidFill: a hole shows sky through the outer brick', () => {
  it('refuses a closed box with a through-hole, however small it is made to look', () => {
    expect(solidFill(...Object.values(boxWithTunnel(0.06))).box).toBe(false); // 12 cm hole
    expect(solidFill(...Object.values(boxWithTunnel(0.03))).box).toBe(false); // 6 cm hole in a 1 m box
  });

  it('the tunnel mesh is a closed, correctly wound solid (a 2 mm pinhole is below what the thresholds can see)', () => {
    const verdict = solidFill(...Object.values(boxWithTunnel(0.001)));
    expect(verdict.box).toBe(true);
    expect(verdict.fill).toBeGreaterThan(0.9999);
    expect(solidFill(...Object.values(boxWithTunnel(0.01))).box).toBe(true); // 2 cm in a 1 m box: 0.04% of the face
    expect(solidFill(...Object.values(boxWithTunnel(0.02))).box).toBe(false); // 4 cm: 0.16% of the face, over the limit
  });

  it('refuses a closed box with an internal void of 0.8% of its volume', () => {
    const outer = boxMesh({ size: [1, 1, 1] });
    const plug = boxMesh({ size: [0.2, 0.2, 0.2], flip: true });
    const position = outer.position.concat(plug.position);
    const index = outer.index.concat(plug.index.map((i) => i + outer.position.length / 3));
    const verdict = solidFill(position, index);
    expect(verdict.fill).toBeLessThan(0.999);
    expect(verdict.box).toBe(false);
  });

  it('refuses a face with a recess, a model too dense to examine, and a plank', () => {
    const dense = new THREE.BoxGeometry(1, 1, 1, 40, 40, 40); // 19,200 triangles
    expect(solidFill(Array.from(dense.attributes.position.array), Array.from(dense.index.array)).box).toBe(false);
    expect(solidFill(...Object.values(boxMesh({ size: [20, 1, 1] }))).box).toBe(false);
    expect(solidFill(...Object.values(boxMesh({ size: [3, 1, 1] }))).box).toBe(true);
  });

  it('can be worked in slices and answers the same', () => {
    const { position, index } = boxMesh({ size: [0.5, 0.5, 0.5] });
    const many = new THREE.BoxGeometry(0.5, 0.5, 0.5, 20, 20, 20);
    const p = Array.from(many.attributes.position.array); const ix = Array.from(many.index.array);
    const job = createSolidFillJob(p, ix);
    let t = 0;
    let steps = 0;
    let verdict = null;
    while (!(verdict = job.step(1, () => (t += 0.6)))) steps++;
    expect(steps).toBeGreaterThan(3);
    expect(verdict.box).toBe(solidFill(p, ix).box);
    expect(verdict.box).toBe(true);
    expect(solidFill(position, index).box).toBe(true);
  });
});

describe('overlapping and piled bricks', () => {
  // Brute-force truth for a set of overlapping axis-aligned bricks: a sample point just outside a brick's face
  // is EXPOSED when it is inside no brick. Every exposed point must lie on a brick the rule leaves drawn.
  function surfaceStaysDrawn(boxes, enclosed) {
    const inside = (p, b, grow) => b.h.every((h, a) => Math.abs(p[a] - b.c[a]) < h + grow);
    let exposedPoints = 0;
    let ok = true;
    boxes.forEach((b, index) => {
      if (!enclosed.has(index)) return;
      for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
        const u = (axis + 1) % 3; const v = (axis + 2) % 3;
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
          const p = [0, 0, 0];
          p[axis] = b.c[axis] + sign * (b.h[axis] + 1e-4);
          p[u] = b.c[u] + (-1 + (2 * (i + 0.5)) / 6) * b.h[u];
          p[v] = b.c[v] + (-1 + (2 * (j + 0.5)) / 6) * b.h[v];
          if (boxes.some((o, k) => k !== index && inside(p, o, 0))) continue;
          ok = false; // an exposed point on a brick the rule left out: a hole in the pile
          exposedPoints++;
        }
      }
    });
    return { ok, exposedPoints };
  }

  it('a chain of bricks that cover each other leaves the outer surface of the pile drawn', () => {
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    let totalEnclosed = 0;
    for (let trial = 0; trial < 25; trial++) {
      const boxes = [];
      // A 5 x 5 x 5 region on a half-brick lattice, so bricks overlap each other by half and cover each other in turn.
      for (let z = 0; z < 9; z++) for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
        if (random() < 0.12) continue; // holes in the pile
        if ((x + y + z) % 2) continue; // an offset lattice: every brick overlaps its neighbours by half
        boxes.push(boxAt(x * LEN / 2, y * LEN / 2, z * LEN / 2));
      }
      const enclosed = findEnclosed(boxes);
      totalEnclosed += enclosed.size;
      const verdict = surfaceStaysDrawn(boxes, enclosed);
      expect(verdict.ok).toBe(true);
    }
    expect(totalEnclosed).toBeGreaterThan(0); // the property was exercised, not vacuous
  });

  it('a pile of hundreds of heavily overlapping bricks is not a wall: bounded time a step, and it finishes', () => {
    let seed = 7;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const boxes = Array.from({ length: 700 }, () => boxAt(random() * 1.2, random() * 1.2, random() * 1.2));
    const job = createEnclosureJob(boxes);
    let worstStep = 0;
    let steps = 0;
    for (;;) {
      const start = performance.now();
      const done = job.step(1);
      worstStep = Math.max(worstStep, performance.now() - start);
      steps++;
      if (done) break;
    }
    expect(worstStep).toBeLessThan(25);
    expect(steps).toBeGreaterThan(5);
    // More than MAX_NEIGHBOURS neighbours: drawn, never culled.
    expect(job.enclosed.size).toBe(0);
    expect(MAX_NEIGHBOURS).toBeLessThan(700);
  });
});
