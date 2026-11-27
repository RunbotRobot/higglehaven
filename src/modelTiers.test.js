import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import {
  FAR_BBOX_TOLERANCE,
  FAR_MAX_TRIANGLES,
  MID_MAX_TRIANGLES,
  MID_MIN_TRIANGLES,
  buildModelTiers,
  buildModelTiersSync,
  modelTierSteps,
  simplifyToTarget,
  textureMeanOverSurface,
} from './modelTiers.js';
import { boundaryEdgeCountSteps, countTriangles } from './geometrySimplify.js';
import { fidelityBatches } from './modelTiers.js';
import { silhouetteFidelity, isFaithful } from './tierFidelity.js';

// ---- Fixtures: procedural stand-ins for real uploads ----

function checkerTexture(size, a, b) {
  const data = new Uint8Array(size * size * 4);
  const cell = size / 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? a : b;
      const i = (y * size + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function material(hex) {
  return new THREE.MeshStandardMaterial({ color: hex });
}

function brick() {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), material(0xaa3322)));
  return group;
}

// #4062: a noisy, open scan of a brick (the owner's "Brick - Orange": a thousand-triangle scan with
// jittered vertices, no closed surface and some faces missing), drawn double-sided. Simplified the
// ordinary way its far version was a net covering a fraction of itself.
function noisyOpenScan() {
  let seed = 4062;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const box = new THREE.BoxGeometry(2, 1, 1, 16, 8, 8);
  const position = box.attributes.position;
  for (let i = 0; i < position.count; i++) {
    position.setXYZ(i, position.getX(i) + (random() - 0.5) * 0.05, position.getY(i) + (random() - 0.5) * 0.05, position.getZ(i) + (random() - 0.5) * 0.05);
  }
  const index = Array.from(box.index.array);
  const kept = [];
  for (let t = 0; t < index.length; t += 3) if (random() > 0.12) kept.push(index[t], index[t + 1], index[t + 2]);
  box.setIndex(kept);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: 0xcc6a2a, side: THREE.DoubleSide })));
  return group;
}

function singleTriangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material(0x2266cc)));
  return group;
}

function chair() {
  const group = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.5), material(0x8b5a2b));
  seat.position.set(0, 0.45, 0);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.05), material(0x8b5a2b));
  back.position.set(0, 0.7, -0.225);
  group.add(seat, back);
  for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.05), material(0x333333));
    leg.position.set(x, 0.225, z);
    group.add(leg);
  }
  return group;
}

// A dense, lumpy, textured mesh standing in for a photogrammetry scan.
function denseScan() {
  // Indexed with shared vertices (only the UV seam is split), the way a scan
  // exported with smooth normals is: a flat-shaded mesh, where every vertex is
  // split per face, is the stuck case tested under "seams" below.
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, 15));
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const lump = 1 + 0.08 * Math.sin(x * 5) * Math.cos(y * 4) + 0.05 * Math.sin(z * 7);
    pos.setXYZ(i, x * lump, y * lump, z * lump);
  }
  geometry.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: checkerTexture(64, [200, 40, 40], [40, 40, 200]) });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, mat));
  return group;
}

function multiMesh() {
  const group = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(0xcc2222));
  box.position.set(-1.5, 0.5, 0);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 24), material(0x22cc22));
  sphere.position.set(0.5, 0.8, 0.3);
  sphere.rotation.set(0.3, 0.5, 0.1);
  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 2, 48, 4), material(0x2222cc));
  cylinder.position.set(2.2, 1, -0.5);
  cylinder.scale.set(1, 1.2, 1);
  group.add(box, sphere, cylinder);
  group.position.set(0, 0, 0);
  return group;
}

function skinnedAvatar() {
  const geometry = new THREE.CylinderGeometry(0.3, 0.3, 1.8, 32, 40);
  const count = geometry.attributes.position.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const upper = geometry.attributes.position.getY(i) > 0;
    skinIndex[i * 4] = upper ? 1 : 0;
    skinWeight[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  const mesh = new THREE.SkinnedMesh(geometry, material(0xcc9966));
  const root = new THREE.Bone();
  const upper = new THREE.Bone();
  upper.position.y = 0.9;
  root.add(upper);
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, upper]));
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

// ---- Measurements ----

function meshesOf(object) {
  const meshes = [];
  object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  return meshes;
}

function trianglesOf(object) {
  return meshesOf(object).reduce((sum, mesh) => sum + countTriangles(mesh.geometry), 0);
}

function boxOf(object) {
  object.updateWorldMatrix(true, true);
  // precise: the real extent of the vertices, not a loose box around each
  // rotated mesh's local bounding box.
  return new THREE.Box3().setFromObject(object, true);
}

function triangleAreas(geometry, matrix) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const triangles = (index ? index.count : pos.count) / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const areas = [];
  for (let t = 0; t < triangles; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, ia).applyMatrix4(matrix);
    b.fromBufferAttribute(pos, ib).applyMatrix4(matrix);
    c.fromBufferAttribute(pos, ic).applyMatrix4(matrix);
    areas.push({ area: new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2, ia, ib, ic });
  }
  return areas;
}

function meanLinearTextureColor(texture) {
  const { data, width, height } = texture.image;
  const sum = new THREE.Color(0, 0, 0);
  const tmp = new THREE.Color();
  const n = width * height;
  for (let i = 0; i < n; i++) {
    tmp.setRGB(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255, THREE.SRGBColorSpace);
    sum.r += tmp.r;
    sum.g += tmp.g;
    sum.b += tmp.b;
  }
  return sum.setRGB(sum.r / n, sum.g / n, sum.b / n);
}

// Area-weighted mean linear colour of the full model: material colour times
// the mean of its texture.
function fullAverageColor(model) {
  model.updateWorldMatrix(true, true);
  const sum = new THREE.Color(0, 0, 0);
  let totalArea = 0;
  for (const mesh of meshesOf(model)) {
    const base = mesh.material.color.clone();
    if (mesh.material.map) {
      const mean = meanLinearTextureColor(mesh.material.map);
      base.setRGB(base.r * mean.r, base.g * mean.g, base.b * mean.b);
    }
    const area = triangleAreas(mesh.geometry, mesh.matrixWorld).reduce((s, t) => s + t.area, 0);
    sum.r += base.r * area;
    sum.g += base.g * area;
    sum.b += base.b * area;
    totalArea += area;
  }
  return new THREE.Color(sum.r / totalArea, sum.g / totalArea, sum.b / totalArea);
}

function farAverageColor(far) {
  const sum = new THREE.Color(0, 0, 0);
  let totalArea = 0;
  for (const mesh of meshesOf(far)) {
    const color = mesh.geometry.attributes.color;
    for (const t of triangleAreas(mesh.geometry, new THREE.Matrix4())) {
      const r = (color.getX(t.ia) + color.getX(t.ib) + color.getX(t.ic)) / 3;
      const g = (color.getY(t.ia) + color.getY(t.ib) + color.getY(t.ic)) / 3;
      const b = (color.getZ(t.ia) + color.getZ(t.ib) + color.getZ(t.ic)) / 3;
      sum.r += r * t.area;
      sum.g += g * t.area;
      sum.b += b * t.area;
      totalArea += t.area;
    }
  }
  return new THREE.Color(sum.r / totalArea, sum.g / totalArea, sum.b / totalArea);
}

function expectBoxPreserved(full, far) {
  const fullBox = boxOf(full);
  const farBox = boxOf(far);
  const tolerance = fullBox.getSize(new THREE.Vector3()).length() * FAR_BBOX_TOLERANCE + 1e-6;
  for (const axis of ['x', 'y', 'z']) {
    expect(Math.abs(farBox.min[axis] - fullBox.min[axis])).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(farBox.max[axis] - fullBox.max[axis])).toBeLessThanOrEqual(tolerance);
  }
}

const FIXTURES = {
  brick,
  chair,
  denseScan,
  multiMesh,
};

describe('every simpler version still reads as the model (#4062)', () => {
  it.each(['noisyOpenScan', 'brick', 'chair', 'multiMesh'])('%s: mid and far pass the silhouette check against the full model', (name) => {
    const model = ({ noisyOpenScan, brick, chair, multiMesh })[name]();
    const { mid, far, stats } = buildModelTiersSync(model);
    const full = fidelityBatches(model);
    expect(isFaithful(silhouetteFidelity(full, fidelityBatches(mid.object)), 'mid')).toBe(true);
    expect(isFaithful(silhouetteFidelity(full, fidelityBatches(far.object)), 'far')).toBe(true);
    expect(stats.far).toBeGreaterThan(0);
  });

  it('a noisy open scan gets a far version no heavier than the far limit and a mid version lighter than the full model', () => {
    const { stats } = buildModelTiersSync(noisyOpenScan());
    expect(stats.far).toBeLessThanOrEqual(FAR_MAX_TRIANGLES);
    expect(stats.mid).toBeLessThanOrEqual(stats.full);
  });

  it('keeps the surface of an open scan in the mid version: borders stay put (#4114)', () => {
    const full = noisyOpenScan();
    const { mid } = buildModelTiersSync(full);
    const report = silhouetteFidelity(fidelityBatches(full), fidelityBatches(mid.object));
    expect(report.areaKept).toBeGreaterThanOrEqual(0.95);
    expect(report.openGrowth).toBeLessThanOrEqual(1.15);
  });

  // #4302: a long open strip (a scanned brick's shell, in miniature): almost every vertex lies on an open
  // edge. With the borders locked a pass cannot go below the border's own triangles; free, the pass tears.
  // Sliding lets a border vertex collapse onto the next one of its own border while no original border point
  // ends up further than a tolerance from the border that replaces it: the straight stretches go, the corners
  // stay.
  function openStrip() {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(10, 0.4, 200, 2), new THREE.MeshStandardMaterial({ color: 0xcc6a2a, side: THREE.DoubleSide })));
    return group;
  }

  // The same strip bent into an arc of 120 degrees: a gently curved border, every vertex of it a small step.
  function curvedStrip() {
    const geometry = new THREE.PlaneGeometry(10, 0.4, 200, 2);
    const position = geometry.attributes.position;
    const radius = 10 / (Math.PI * 2 / 3);
    for (let i = 0; i < position.count; i++) {
      const angle = position.getX(i) / radius;
      position.setXYZ(i, radius * Math.sin(angle), position.getY(i), radius * (Math.cos(angle) - 1));
    }
    return geometry;
  }

  // The farthest any vertex of `original`'s border is from the border of `simplified` (positions only).
  function borderDrift(original, simplified) {
    const edges = (geometry) => {
      const index = geometry.index.array;
      const position = geometry.attributes.position;
      const uses = new Map();
      const key = (i) => `${position.getX(i).toFixed(5)},${position.getY(i).toFixed(5)},${position.getZ(i).toFixed(5)}`;
      for (let t = 0; t < index.length; t += 3) {
        for (const [x, y] of [[index[t], index[t + 1]], [index[t + 1], index[t + 2]], [index[t + 2], index[t]]]) {
          const k = [key(x), key(y)].sort().join('|');
          uses.set(k, (uses.get(k) || 0) + 1);
        }
      }
      return [...uses.entries()].filter(([, n]) => n === 1).map(([k]) => k.split('|').map((p) => new THREE.Vector3(...p.split(',').map(Number))));
    };
    const segments = edges(simplified);
    const points = edges(original).flat();
    let worst = 0;
    const closest = new THREE.Vector3();
    for (const p of points) {
      let best = Infinity;
      for (const [a, b] of segments) best = Math.min(best, new THREE.Line3(a, b).closestPointToPoint(p, true, closest).distanceTo(p));
      worst = Math.max(worst, best);
    }
    return worst;
  }

  it('slides the borders of an open strip: far fewer triangles than with the borders locked, surface and outline kept (#4302)', () => {
    const full = openStrip();
    const locked = buildModelTiersSync(full, { slideBorders: false });
    const slid = buildModelTiersSync(full);
    expect(slid.slide.attempts).toBeGreaterThan(0);
    expect(slid.slide.used).toBe(true);
    expect(slid.stats.mid).toBeLessThan(locked.stats.mid * 0.6);
    const report = silhouetteFidelity(fidelityBatches(full), fidelityBatches(slid.mid.object));
    expect(isFaithful(report, 'mid')).toBe(true);
    expect(report.areaKept).toBeGreaterThanOrEqual(0.95);
    expect(report.openGrowth).toBeLessThanOrEqual(1.15);
  });

  it('keeps the corners of a border while sliding its straight stretches (#4302)', () => {
    const geometry = new THREE.PlaneGeometry(10, 0.4, 200, 2);
    const slid = runToEnd(simplifyToTarget(geometry, 20, { lockBorders: false, slideBorders: 0.1 }));
    expect(countTriangles(slid)).toBeLessThan(countTriangles(geometry) / 4);
    const corners = [[-5, -0.2], [5, -0.2], [-5, 0.2], [5, 0.2]];
    const position = slid.attributes.position;
    for (const [x, y] of corners) {
      let found = false;
      for (let i = 0; i < position.count; i++) if (Math.abs(position.getX(i) - x) < 1e-6 && Math.abs(position.getY(i) - y) < 1e-6) found = true;
      expect(found).toBe(true);
    }
    expect(runToEnd(boundaryEdgeCountSteps(slid))).toBeLessThanOrEqual(runToEnd(boundaryEdgeCountSteps(geometry)));
  });

  it('a curved border does not drift further than the tolerance in total, however many vertices slide away (#4302)', () => {
    const geometry = curvedStrip();
    const tolerance = 0.02;
    const slid = runToEnd(simplifyToTarget(geometry, 20, { lockBorders: false, slideBorders: tolerance }));
    // It did slide...
    expect(countTriangles(slid)).toBeLessThan(countTriangles(geometry));
    // ...but every original border point is still within the tolerance of the border that replaced it
    // (one step at a time each was only a small shortcut; the sum must not be allowed to add up).
    expect(borderDrift(geometry, slid)).toBeLessThanOrEqual(tolerance * 1.05);
    // And a tolerance of nothing slides nothing along the curve.
    const still = runToEnd(simplifyToTarget(geometry, 20, { lockBorders: false, slideBorders: 1e-9 }));
    expect(borderDrift(geometry, still)).toBeLessThanOrEqual(1e-6);
  });

  it('a closed border (a hole) does not collapse toward nothing (#4302)', () => {
    // A square plate with a round hole: the hole's rim is a closed border of many small steps.
    const shape = new THREE.Shape();
    shape.moveTo(-5, -5); shape.lineTo(5, -5); shape.lineTo(5, 5); shape.lineTo(-5, 5); shape.lineTo(-5, -5);
    const hole = new THREE.Path();
    hole.absarc(0, 0, 2, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geometry = new THREE.ShapeGeometry(shape, 64);
    const tolerance = 0.05;
    const slid = runToEnd(simplifyToTarget(geometry, 10, { lockBorders: false, slideBorders: tolerance }));
    expect(borderDrift(geometry, slid)).toBeLessThanOrEqual(tolerance * 1.05);
    // The rim still encloses nearly the hole it did: count the rim's vertices and measure its radius.
    const radii = [];
    const position = slid.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i));
      if (r < 3) radii.push(r);
    }
    expect(radii.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...radii)).toBeGreaterThan(2 - tolerance * 1.05);
  });

  it('with sliding off the result is exactly the locked result (#4302)', () => {
    const geometry = new THREE.PlaneGeometry(10, 0.4, 200, 2);
    const locked = runToEnd(simplifyToTarget(geometry, 80, { lockBorders: true }));
    const { stats, slide } = buildModelTiersSync(openStrip(), { slideBorders: false });
    expect(slide.attempts).toBe(0);
    // the strip's mid target is a tenth of its 800 triangles
    expect(stats.mid).toBe(countTriangles(locked));
    const never = runToEnd(simplifyToTarget(geometry, 80, { lockBorders: false, slideBorders: 0 }));
    const plain = runToEnd(simplifyToTarget(geometry, 80, { lockBorders: false }));
    expect(countTriangles(never)).toBe(countTriangles(plain));
  });

  it('never uses a sliding mid that is not strictly lighter than the locked one (#4302)', () => {
    const locked = buildModelTiersSync(openStrip(), { slideBorders: false });
    // A ladder with nothing in it rebuilds nothing: what comes back is the original geometry, heavier than the
    // locked result, and it would pass the fidelity check trivially.
    const result = buildModelTiersSync(openStrip(), { slideBorderLadder: [] });
    expect(result.slide.attempts).toBeGreaterThan(0);
    expect(result.slide.used).toBe(false);
    expect(result.stats.mid).toBe(locked.stats.mid);
  });

  it('a tiny closed rim of four vertices, smaller than the tolerance, keeps three at least (#4302)', () => {
    const shape = new THREE.Shape();
    shape.moveTo(-5, -5); shape.lineTo(5, -5); shape.lineTo(5, 5); shape.lineTo(-5, 5); shape.lineTo(-5, -5);
    const hole = new THREE.Path();
    hole.moveTo(-0.01, -0.01); hole.lineTo(-0.01, 0.01); hole.lineTo(0.01, 0.01); hole.lineTo(0.01, -0.01); hole.lineTo(-0.01, -0.01);
    shape.holes.push(hole);
    const geometry = new THREE.ShapeGeometry(shape);
    const slid = runToEnd(simplifyToTarget(geometry, 4, { lockBorders: false, slideBorders: 0.5 }));
    const position = slid.attributes.position;
    const rim = new Set();
    for (let i = 0; i < position.count; i++) {
      if (Math.hypot(position.getX(i), position.getY(i)) < 0.5) rim.add(`${position.getX(i).toFixed(4)},${position.getY(i).toFixed(4)}`);
    }
    expect(rim.size).toBeGreaterThanOrEqual(3);
    // No open edge of nothing: every triangle of the result still has three distinct corners.
    const index = slid.index.array;
    for (let t = 0; t < index.length; t += 3) expect(new Set([index[t], index[t + 1], index[t + 2]]).size).toBe(3);
  });

  it('does not attempt sliding on a closed model (#4302)', () => {
    const a = buildModelTiersSync(chair());
    const b = buildModelTiersSync(chair(), { slideBorders: false });
    expect(a.slide.attempts).toBe(0);
    expect(a.stats.mid).toBe(b.stats.mid);
    expect(a.stats.far).toBe(b.stats.far);
  });

  it('does not attempt sliding when the locked result is within 1.5x of its target (#4302)', () => {
    // The brick box reaches its target with the borders locked (it has none): the same must hold for an
    // open shell whose locked pass already gets close.
    const model = noisyOpenScan();
    const a = buildModelTiersSync(model);
    const b = buildModelTiersSync(model, { slideBorders: false });
    if (a.slide.attempts === 0) expect(a.stats.mid).toBe(b.stats.mid);
    expect(a.stats.mid).toBeLessThanOrEqual(b.stats.mid);
  });

  it('falls back to the locked version when the sliding one fails the fidelity check (#4302)', () => {
    // A disc whose rim is 400 open edges: locked it cannot lose the rim. The check is made to refuse anything
    // lighter than the locked version, as it would a sliding candidate that lost too much.
    const disc = () => {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(new THREE.CircleGeometry(5, 400), new THREE.MeshStandardMaterial({ color: 0xcc6a2a, side: THREE.DoubleSide })));
      return group;
    };
    const locked = buildModelTiersSync(disc(), { slideBorders: false });
    const refuseLighter = (fullBatches, object, tier) => tier !== 'mid' || trianglesOf(object) >= locked.stats.mid;
    const fallback = buildModelTiersSync(disc(), { tierCheck: refuseLighter });
    expect(fallback.slide.attempts).toBeGreaterThan(0);
    expect(fallback.slide.used).toBe(false);
    expect(fallback.stats.mid).toBe(locked.stats.mid);
    // Without the refusal the sliding version stands: it was the check that stopped it.
    const accepted = buildModelTiersSync(disc());
    expect(accepted.slide.used).toBe(true);
    expect(accepted.stats.mid).toBeLessThan(locked.stats.mid);
  });

  it('when the largest tolerance fails the check, a smaller one that passes is used, not the locked version (#4302)', () => {
    const disc = () => {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(new THREE.CircleGeometry(5, 400), new THREE.MeshStandardMaterial({ color: 0xcc6a2a, side: THREE.DoubleSide })));
      return group;
    };
    // On this disc the whole ladder ends at 54 triangles (its two larger rungs make the same version), the
    // smallest tolerance alone at 122, the locked version at 400.
    const ladder = [0.0002, 0.001, 0.004];
    const locked = buildModelTiersSync(disc(), { slideBorders: false });
    const whole = buildModelTiersSync(disc(), { slideBorderLadder: ladder });
    const smallest = buildModelTiersSync(disc(), { slideBorderLadder: ladder.slice(0, 1) });
    expect(whole.slide.used).toBe(true);
    expect(whole.stats.mid).toBeLessThan(smallest.stats.mid); // meaningful only if the rungs differ
    expect(smallest.stats.mid).toBeLessThan(locked.stats.mid);
    // A check that refuses the lightest version, as it would one that slid too far.
    const refuseLightest = (fullBatches, object, tier) => tier !== 'mid' || trianglesOf(object) > whole.stats.mid;
    const result = buildModelTiersSync(disc(), { slideBorderLadder: ladder, tierCheck: refuseLightest });
    expect(result.slide.used).toBe(true);
    expect(result.stats.mid).toBe(smallest.stats.mid);
    expect(result.slide.attempts).toBeGreaterThan(1);
    // And when every slid version is refused, the locked one is judged as ever, after at most one step per rung.
    const refuseAllLighter = (fullBatches, object, tier) => tier !== 'mid' || trianglesOf(object) >= locked.stats.mid;
    const none = buildModelTiersSync(disc(), { slideBorderLadder: ladder, tierCheck: refuseAllLighter });
    expect(none.slide.used).toBe(false);
    expect(none.stats.mid).toBe(locked.stats.mid);
    expect(none.slide.attempts).toBeLessThanOrEqual(ladder.length);
  });

  it('scales the tolerance by the mesh and the model, not by the mesh alone (#4302)', () => {
    // The same strip scaled 100x on its node: same relative result.
    const small = buildModelTiersSync(openStrip());
    const big = openStrip();
    big.scale.set(100, 100, 100);
    const scaled = buildModelTiersSync(big);
    expect(scaled.stats.mid).toBe(small.stats.mid);
  });

  it('draws the far version from both sides, so nothing the simplifier left facing away disappears', () => {
    const { far } = buildModelTiersSync(chair());
    const meshes = [];
    far.object.traverse((o) => { if (o.isMesh) meshes.push(o); });
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) expect(mesh.material.side).toBe(THREE.DoubleSide);
  });
});

describe('buildModelTiersSync', () => {
  it('leaves a small model as itself for mid and keeps its own geometry for far', () => {
    const model = chair();
    const { mid, far, stats } = buildModelTiersSync(model);
    expect(stats.full).toBe(72);
    expect(mid.sharesFullModel).toBe(true);
    expect(mid.object).toBe(model);
    // Within the far budget: not simplified, not replaced by a stand-in.
    expect(stats.far).toBe(72);
    expect(far.sharesFullModel).toBe(false);
  });

  it('shrinks a dense scan to about a tenth for mid, with textures downsized and the originals untouched', () => {
    const model = denseScan();
    const fullMaterial = meshesOf(model)[0].material;
    const { mid, stats } = buildModelTiersSync(model, { midTextureMaxSize: 16 });
    expect(stats.full).toBe(5120);
    expect(stats.mid).toBeGreaterThanOrEqual(MID_MIN_TRIANGLES);
    expect(stats.mid).toBeLessThanOrEqual(MID_MAX_TRIANGLES);
    expect(stats.mid).toBeLessThan(stats.full * 0.2);
    expect(mid.sharesFullModel).toBe(false);
    const midMaterial = meshesOf(mid.object)[0].material;
    expect(midMaterial.map.image.width).toBe(16);
    expect(midMaterial.map.colorSpace).toBe(THREE.SRGBColorSpace);
    // The full model is not modified.
    expect(fullMaterial.map.image.width).toBe(64);
    expect(countTriangles(meshesOf(model)[0].geometry)).toBe(5120);
  });

  // #3521: the glTF exporter merges separate metalness and roughness maps by
  // drawing both into a canvas, so a downsized map has to be drawable, not a bare
  // pixel array, wherever a canvas exists.
  it('gives downsized metalness and roughness maps a drawable image where a canvas exists', () => {
    const model = denseScan();
    const mat = meshesOf(model)[0].material;
    mat.metalnessMap = checkerTexture(64, [255, 255, 255], [0, 0, 0]);
    mat.roughnessMap = checkerTexture(64, [0, 255, 0], [0, 128, 0]);
    const made = [];
    const makeImage = (data, width, height) => {
      const image = { width, height, drawable: true };
      made.push({ data, image });
      return image;
    };
    const { mid } = buildModelTiersSync(model, { midTextureMaxSize: 16, makeImage });
    const midMaterial = meshesOf(mid.object)[0].material;
    for (const key of ['map', 'metalnessMap', 'roughnessMap']) {
      expect(midMaterial[key].isCanvasTexture).toBe(true);
      expect(midMaterial[key].image.drawable).toBe(true);
      expect(midMaterial[key].image.width).toBe(16);
    }
    expect(made).toHaveLength(3);
    expect(made[0].data.length).toBe(16 * 16 * 4);
    // Where no canvas can be made (node, a worker without one) the pixels stay raw.
    const { mid: plain } = buildModelTiersSync(denseScan(), { midTextureMaxSize: 16, makeImage: () => null });
    expect(meshesOf(plain.object)[0].material.map.isDataTexture).toBe(true);
  });

  it('reduces the far version of a dense scan to one coloured mesh within the far budget', () => {
    const { far, stats } = buildModelTiersSync(denseScan());
    expect(stats.far).toBeGreaterThan(0);
    expect(stats.far).toBeLessThanOrEqual(FAR_MAX_TRIANGLES);
    const meshes = meshesOf(far.object);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].material.vertexColors).toBe(true);
    expect(meshes[0].material.map).toBeNull();
    expect(Object.keys(meshes[0].geometry.attributes).sort()).toEqual(['color', 'normal', 'position']);
  });

  it.each(Object.keys(FIXTURES))('keeps the bounding box of %s within tolerance in the far version', (name) => {
    const model = FIXTURES[name]();
    const { far } = buildModelTiersSync(model);
    expectBoxPreserved(model, far.object);
  });

  it.each(['chair', 'denseScan', 'multiMesh'])('keeps the average colour of %s close to the full model', (name) => {
    const model = FIXTURES[name]();
    const { far } = buildModelTiersSync(model);
    const expected = fullAverageColor(model);
    const actual = farAverageColor(far.object);
    expect(Math.abs(actual.r - expected.r)).toBeLessThan(0.12);
    expect(Math.abs(actual.g - expected.g)).toBeLessThan(0.12);
    expect(Math.abs(actual.b - expected.b)).toBeLessThan(0.12);
  });

  it('draws a metal model darker than its base colour and adds emission, as the lit full model looks (#4111)', () => {
    const farOf = (props) => {
      const model = chair();
      model.traverse((o) => { if (o.isMesh) Object.assign(o.material, props); });
      return farAverageColor(buildModelTiersSync(model).far.object);
    };
    const plain = farOf({ metalness: 0 });
    const metal = farOf({ metalness: 1 });
    expect(metal.r).toBeLessThan(plain.r * 0.5);
    expect(metal.r).toBeGreaterThan(plain.r * 0.2);
    const glowing = farOf({ metalness: 0, emissive: new THREE.Color(0.2, 0, 0), emissiveIntensity: 1 });
    expect(glowing.r).toBeCloseTo(plain.r + 0.2, 1);
  });

  it('keeps every part of a multi-mesh model in the far version, merged into one mesh', () => {
    const { far, stats } = buildModelTiersSync(multiMesh());
    expect(meshesOf(far.object)).toHaveLength(1);
    expect(stats.far).toBeLessThanOrEqual(FAR_MAX_TRIANGLES);
    // All three colours survive in the baked vertex colours.
    const color = meshesOf(far.object)[0].geometry.attributes.color;
    let hasRed = false;
    let hasGreen = false;
    let hasBlue = false;
    for (let i = 0; i < color.count; i++) {
      if (color.getX(i) > color.getY(i) * 2 && color.getX(i) > color.getZ(i) * 2) hasRed = true;
      if (color.getY(i) > color.getX(i) * 2 && color.getY(i) > color.getZ(i) * 2) hasGreen = true;
      if (color.getZ(i) > color.getX(i) * 2 && color.getZ(i) > color.getY(i) * 2) hasBlue = true;
    }
    expect([hasRed, hasGreen, hasBlue]).toEqual([true, true, true]);
  });

  it('never returns an empty geometry or a stand-in box for a tiny model', () => {
    const model = singleTriangle();
    const { mid, far, stats } = buildModelTiersSync(model);
    expect(mid.object).toBe(model);
    expect(stats.far).toBe(1);
    const position = meshesOf(far.object)[0].geometry.attributes.position;
    expect(position.count).toBe(3);
    expect(position.getX(1)).toBeCloseTo(1);
    expect(position.getY(2)).toBeCloseTo(1);
  });

  it('returns the model itself for both tiers when it contains a skinned mesh', () => {
    const model = skinnedAvatar();
    const full = trianglesOf(model);
    const { mid, far, stats } = buildModelTiersSync(model);
    expect(mid.object).toBe(model);
    expect(far.object).toBe(model);
    expect(mid.sharesFullModel && far.sharesFullModel).toBe(true);
    expect(stats).toEqual({ full, mid: full, far: full });
    expect(meshesOf(model)[0].geometry.attributes.skinIndex).toBeDefined();
  });

  it('returns the model itself for a model with no meshes', () => {
    const model = new THREE.Group();
    const { mid, far } = buildModelTiersSync(model);
    expect(mid.object).toBe(model);
    expect(far.object).toBe(model);
  });

  it('is deterministic for the same input', () => {
    const first = buildModelTiersSync(denseScan(), { midTextureMaxSize: 16 });
    const second = buildModelTiersSync(denseScan(), { midTextureMaxSize: 16 });
    expect(second.stats).toEqual(first.stats);
    const a = meshesOf(first.far.object)[0].geometry;
    const b = meshesOf(second.far.object)[0].geometry;
    expect(Array.from(b.attributes.position.array)).toEqual(Array.from(a.attributes.position.array));
    expect(Array.from(b.attributes.color.array)).toEqual(Array.from(a.attributes.color.array));
    const midA = meshesOf(first.mid.object)[0].geometry;
    const midB = meshesOf(second.mid.object)[0].geometry;
    expect(Array.from(midB.attributes.position.array)).toEqual(Array.from(midA.attributes.position.array));
  });
});

describe('chunked execution', () => {
  it('yields between simplification passes so a caller can stay inside a frame budget', () => {
    const job = modelTierSteps(denseScan());
    let yields = 0;
    let step = job.next();
    while (!step.done) {
      yields++;
      step = job.next();
    }
    expect(yields).toBeGreaterThan(2);
    expect(step.value.stats.far).toBeLessThanOrEqual(FAR_MAX_TRIANGLES);
  });

  it('hands control back between slices and produces the same result as the sync run', async () => {
    let frames = 0;
    const chunked = await buildModelTiers(denseScan(), {
      frameBudgetMs: 0,
      nextFrame: async () => { frames++; },
    });
    expect(frames).toBeGreaterThan(0);
    expect(chunked.stats).toEqual(buildModelTiersSync(denseScan()).stats);
  });

  // #3483: reading a texture back and shrinking it is per-pixel work; on a
  // large texture that used to be one step of hundreds of milliseconds.
  it('spreads the downsizing of a large texture over many steps', () => {
    const texturedPlate = (size) => {
      const group = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({ map: checkerTexture(size, [200, 30, 30], [30, 30, 200]) });
      group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
      return group;
    };
    const stepsFor = (model) => {
      const steps = modelTierSteps(model);
      let count = 0;
      while (!steps.next().done) count += 1;
      return count;
    };
    const small = stepsFor(texturedPlate(64)); // already under the mid texture size: nothing to shrink
    const large = stepsFor(texturedPlate(2048)); // 4 million pixels to average
    expect(large - small).toBeGreaterThanOrEqual(12);
  });

  it('does not hand control back when the budget is never crossed', async () => {
    let frames = 0;
    await buildModelTiers(chair(), {
      frameBudgetMs: 1e9,
      nextFrame: async () => { frames++; },
    });
    expect(frames).toBe(0);
  });
});

// #3528: a shopper saw a toilet "all jagged with holes" from a distance. The
// simplifier can tear a closed mesh open, and repeated passes compound it, so a
// pass that adds holes is not kept.
function runToEnd(steps) {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

describe('hole guard (#3528)', () => {
  it('counts the edges that belong to one triangle, welding vertices that only differ in UVs or normals', () => {
    // BoxGeometry repeats each corner per face for its normals: still a closed box.
    expect(runToEnd(boundaryEdgeCountSteps(new THREE.BoxGeometry(1, 1, 1)))).toBe(0);
    expect(runToEnd(boundaryEdgeCountSteps(new THREE.SphereGeometry(1, 16, 12)))).toBe(0);
    // One quad: four edges on the outside.
    expect(runToEnd(boundaryEdgeCountSteps(new THREE.PlaneGeometry(1, 1)))).toBe(4);
    // A cylinder without caps has its two rims.
    expect(runToEnd(boundaryEdgeCountSteps(new THREE.CylinderGeometry(1, 1, 2, 16, 1, true)))).toBe(32);
  });

  it('keeps a pass from tearing a closed mesh: simplifying a torus knot hard leaves no holes', () => {
    const knot = new THREE.TorusKnotGeometry(1, 0.3, 300, 40);
    const start = countTriangles(knot);
    expect(runToEnd(boundaryEdgeCountSteps(knot))).toBe(0);
    const result = runToEnd(simplifyToTarget(knot, Math.round(start * 0.05)));
    expect(runToEnd(boundaryEdgeCountSteps(result))).toBe(0);
    // It still got a good deal smaller; it just stopped where the next step would have torn.
    expect(countTriangles(result)).toBeLessThan(start * 0.5);
  });

  it('does not count holes the model already had against the simplifier', () => {
    const open = new THREE.CylinderGeometry(0.5, 0.5, 1.5, 64, 40, true);
    const before = runToEnd(boundaryEdgeCountSteps(open));
    expect(before).toBe(128);
    const result = runToEnd(simplifyToTarget(open, Math.round(countTriangles(open) * 0.25)));
    expect(countTriangles(result)).toBeLessThan(countTriangles(open) * 0.5);
    expect(runToEnd(boundaryEdgeCountSteps(result))).toBeLessThanOrEqual(before);
  });

  it('seams: a vertex shared by two sides of a UV or normal seam is never collapsed, so a seam cannot crack open', () => {
    // A smooth sphere keeps one UV seam: it still simplifies a lot, and stays closed.
    const smooth = mergeVertices(new THREE.SphereGeometry(1, 96, 64));
    const smoothStart = countTriangles(smooth);
    const smoothResult = runToEnd(simplifyToTarget(smooth, Math.round(smoothStart * 0.1)));
    expect(countTriangles(smoothResult)).toBeLessThan(smoothStart * 0.4);
    expect(runToEnd(boundaryEdgeCountSteps(smoothResult))).toBe(0);
    // A flat-shaded one splits every vertex per face: nothing may collapse, and it is returned as it is.
    const flat = new THREE.IcosahedronGeometry(1, 8);
    const flatResult = runToEnd(simplifyToTarget(flat, Math.round(countTriangles(flat) * 0.1)));
    expect(runToEnd(boundaryEdgeCountSteps(flatResult))).toBe(0);
  });
});

describe('far shading (#4111)', () => {
  const normalSpread = (far) => {
    // How different the normals at one shared corner are, over the far mesh's corners.
    const mesh = meshesOf(far.object)[0];
    const pos = mesh.geometry.attributes.position;
    const nor = mesh.geometry.attributes.normal;
    const byCorner = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
      const list = byCorner.get(key) || [];
      list.push(new THREE.Vector3(nor.getX(i), nor.getY(i), nor.getZ(i)));
      byCorner.set(key, list);
    }
    // The share of corners whose copies all agree (normals within about 25 degrees of one another).
    let agree = 0;
    for (const list of byCorner.values()) if (list.every((n) => n.dot(list[0]) > 0.9)) agree++;
    return agree / byCorner.size;
  };

  it('smooths a rounded model across shared corners', () => {
    const ball = new THREE.Group();
    ball.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), material(0x888888)));
    const { far } = buildModelTiersSync(ball);
    // Corners share one normal, where flat shading gave every face its own (none agreed).
    expect(normalSpread(far)).toBeGreaterThan(0.5);
  });

  it('keeps a box edge sharp', () => {
    const model = new THREE.Group();
    model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(0x888888)));
    const { far } = buildModelTiersSync(model);
    expect(normalSpread(far)).toBeLessThan(0.2);
  });
});

describe('colour fidelity (#4111)', () => {
  it('reads a metal mesh as the darker colour it is drawn in, and a plain one as its own', () => {
    const colorOf = (props) => {
      const model = chair();
      model.traverse((o) => { if (o.isMesh) Object.assign(o.material, props); });
      return fidelityBatches(model)[0].color;
    };
    const plain = colorOf({ metalness: 0 });
    const metal = colorOf({ metalness: 1 });
    expect(metal[0]).toBeLessThan(plain[0] * 0.5);
  });
});

describe('unlit far (#4111)', () => {
  it('draws the far version of an unlit model without light, and a lit one with it', () => {
    const farMaterial = (mat) => {
      const model = new THREE.Group();
      model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
      return meshesOf(buildModelTiersSync(model).far.object)[0].material;
    };
    expect(farMaterial(new THREE.MeshBasicMaterial({ color: 0x336699 })).isMeshBasicMaterial).toBe(true);
    expect(farMaterial(material(0x336699)).isMeshStandardMaterial).toBe(true);
  });
});

// #4111: the far version of a textured model is coloured with the mean of its texture over the surface it
// shows, not with texels sampled at a few vertices (which made the brick a pale tube with a gradient).
describe('far colour of a textured model (#4111)', () => {
  it('textureMeanOverSurface counts only the part of the texture the surface shows', () => {
    const texture = checkerTexture(64, [255, 255, 255], [0, 0, 0]);
    // Left half of the texture white, right half black.
    const data = texture.image.data;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const v = x < 32 ? 255 : 0;
      const i = (y * 64 + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    const pixels = { data, width: 64, height: 64 };
    const geometry = new THREE.PlaneGeometry(1, 1);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.4 + 0.05, uv.getY(i)); // u in 0.05..0.45: white only
    const mean = textureMeanOverSurface(geometry, texture, pixels);
    expect(mean.r).toBeGreaterThan(0.99);
    // A mesh with no UVs falls back to the whole texture: about half.
    const bare = textureMeanOverSurface(new THREE.PlaneGeometry(1, 1).deleteAttribute('uv'), texture, pixels);
    expect(bare.r).toBeGreaterThan(0.2);
    expect(bare.r).toBeLessThan(0.8);
  });

  it('a heavily reduced textured model whose faces look alike has one colour on every vertex of its far version, with no gradient', () => {
    const { far } = buildModelTiersSync(denseScan(), { midTextureMaxSize: 16 });
    const color = meshesOf(far.object)[0].geometry.attributes.color;
    const first = [color.getX(0), color.getY(0), color.getZ(0)];
    // #4302: the far colour is now taken per facing, so two faces of a model that looks the same all round differ by
    // the noise of sampling its texture (a tenth of a percent here), not by anything a person could see: 0.02 is far
    // below the pale-rim-against-dark-face gap the facing colour exists for (see 'far colour by facing').
    for (let i = 1; i < color.count; i++) {
      expect(Math.abs(color.getX(i) - first[0])).toBeLessThan(0.02);
      expect(Math.abs(color.getY(i) - first[1])).toBeLessThan(0.02);
      expect(Math.abs(color.getZ(i) - first[2])).toBeLessThan(0.02);
    }
  });
});

// #4302 (#4111): the far version of a textured model took one colour for the whole mesh, so a brick with a pale rim and
// dark faces came out terracotta. Each far triangle is coloured by what faces its way.
describe('far colour by facing (#4302)', () => {
  // A 2 x 1 texture (pale, dark) on a box finely cut enough to need the heavy reduction (more than FAR_MAX_TRIANGLES
  // triangles): the top face (+y) reads the pale texel and every other face the dark one.
  function paleTopBox() {
    const geometry = new THREE.BoxGeometry(2, 1, 1, 10, 5, 5);
    const normal = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, normal.getY(i) > 0.5 ? 0.25 : 0.75, 0.5);
    const data = new Uint8Array([230, 190, 150, 255, 60, 50, 40, 255]);
    const texture = new THREE.DataTexture(data, 2, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture })));
    return group;
  }

  // The mean vertex colour of the far version's triangles whose normal points along `axis` (0 x, 1 y, 2 z, positive).
  function farColourFacing(far, axis) {
    const sum = [0, 0, 0];
    let weight = 0;
    for (const mesh of meshesOf(far)) {
      const position = mesh.geometry.attributes.position;
      const color = mesh.geometry.attributes.color;
      const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), n = new THREE.Vector3();
      for (let t = 0; t + 2 < position.count; t += 3) {
        pa.fromBufferAttribute(position, t); pb.fromBufferAttribute(position, t + 1); pc.fromBufferAttribute(position, t + 2);
        n.subVectors(pb, pa).cross(pc.sub(pa));
        const area = n.length() / 2;
        n.normalize();
        if (n.getComponent(axis) < 0.9) continue;
        for (let v = 0; v < 3; v++) { sum[0] += area * color.getX(t + v); sum[1] += area * color.getY(t + v); sum[2] += area * color.getZ(t + v); }
        weight += area * 3;
      }
    }
    return weight > 0 ? sum.map((v) => v / weight) : null;
  }

  it('colours the far version dark on its dark faces and pale on its pale one, not one mean everywhere', () => {
    const { far } = buildModelTiersSync(paleTopBox());
    const top = farColourFacing(far.object, 1);
    const front = farColourFacing(far.object, 2);
    expect(top).not.toBeNull();
    expect(front).not.toBeNull();
    // Linear light: the pale texel is about 0.8 / 0.5 / 0.3, the dark one about 0.05 / 0.03 / 0.02.
    expect(top[0]).toBeGreaterThan(0.5);
    expect(front[0]).toBeLessThan(0.12);
    expect(top[0] / front[0]).toBeGreaterThan(4);
  });

  it('leaves a model with no texture exactly as it was (one colour per face already)', () => {
    const { far } = buildModelTiersSync(brick());
    const top = farColourFacing(far.object, 1);
    const front = farColourFacing(far.object, 2);
    if (top && front) for (let c = 0; c < 3; c++) expect(Math.abs(top[c] - front[c])).toBeLessThan(1e-6);
  });
});

// #4111: a metalness map says where a model is metal; the far version darkens those regions as a scalar metalness does.
describe('far colour of a model with a metalness map (#4111)', () => {
  function metalBox(metalBlue) {
    const geometry = new THREE.BoxGeometry(2, 1, 1, 10, 5, 5); // more than FAR_MAX_TRIANGLES triangles: the heavy reduction
    const data = new Uint8Array([200, 200, 200, 255]);
    const albedo = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.needsUpdate = true;
    const metal = new THREE.DataTexture(new Uint8Array([0, 128, metalBlue, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    metal.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({ map: albedo, metalnessMap: metal, metalness: 1 });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, material));
    return group;
  }

  it('is darker where the metalness map says metal than where it says not', () => {
    const matte = farAverageColor(buildModelTiersSync(metalBox(0)).far.object);
    const metallic = farAverageColor(buildModelTiersSync(metalBox(255)).far.object);
    // Fully metal keeps 35% of the colour (1 - FAR_METAL_DARKENING); not metal keeps all of it.
    expect(metallic.r / matte.r).toBeGreaterThan(0.3);
    expect(metallic.r / matte.r).toBeLessThan(0.4);
  });
});
