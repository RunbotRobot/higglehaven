import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FAR_BBOX_TOLERANCE,
  FAR_MAX_TRIANGLES,
  MID_MAX_TRIANGLES,
  MID_MIN_TRIANGLES,
  buildModelTiers,
  buildModelTiersSync,
  modelTierSteps,
} from './modelTiers.js';
import { countTriangles } from './geometrySimplify.js';

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
  const geometry = new THREE.IcosahedronGeometry(1, 15);
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
