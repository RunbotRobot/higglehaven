// #1682: optimizeModelFile computed removeCount (how many vertices
// SimplifyModifier should collapse) against the geometry's raw, pre-merge
// vertex count -- but simplifier.modify() (src/vendor/
// SimplifyModifierExtraUV.js) always merges duplicate vertices internally
// before collapsing, a no-op for an already-indexed mesh but not for a
// non-indexed one (one vertex per triangle corner, no sharing), whose raw
// position.count is far larger than its real unique-vertex working set.
// removeCount vastly overshot that smaller working set, decimating a
// non-indexed mesh over the per-mesh triangle budget down to nothing
// instead of toward TARGET_TRIANGLES_PER_MESH.
//
// Calls window.__optimizeModelFileForTests directly (same convention as
// __rescaleModelFileForTests, #1583) rather than driving the real upload
// wizard UI -- the fixture needs to be a genuinely non-indexed mesh well
// over the decimation threshold, easiest to build dynamically in Node
// with three.js/GLTFExporter (BufferGeometry.toNonIndexed()) rather than
// hand-authoring another binary fixture.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { launchPage, finish } from './helpers.mjs';

// Node has no FileReader -- GLTFExporter's own binary-export path uses it
// internally. Same minimal polyfill e2e/upload-multiroot-rescale.test.mjs
// already uses for GLTFLoader's equivalent binary-parse path.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
};

const { browser, page, errors } = await launchPage();

// 100x100 segments -> ~20,000 triangles indexed; toNonIndexed() then
// duplicates every shared vertex per triangle corner, the same shape a
// non-indexed glTF export (or an undecimated video-to-3D/photogrammetry
// mesh) has. Comfortably over TARGET_TRIANGLES_PER_MESH (8000).
const indexedGeometry = new THREE.SphereGeometry(1, 100, 100);
const nonIndexedGeometry = indexedGeometry.toNonIndexed();
const mesh = new THREE.Mesh(nonIndexedGeometry, new THREE.MeshStandardMaterial());
const scene = new THREE.Scene();
scene.add(mesh);
const exportedBuffer = await new GLTFExporter().parseAsync(scene, { binary: true });
const originalBase64 = Buffer.from(exportedBuffer).toString('base64');

const result = await page.evaluate(async (base64) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'non-indexed-sphere.glb', { type: 'model/gltf-binary' });
  const optimized = await window.__optimizeModelFileForTests(file, () => {});
  return { trianglesBefore: optimized.trianglesBefore, trianglesAfter: optimized.trianglesAfter };
}, originalBase64);

console.log('non-indexed high-poly sphere triangle counts before/after decimation (after should land near 8000, not collapse to near-zero):', result);

const notCollapsedToNothing = result.trianglesAfter > 1000;
const reducedSubstantially = result.trianglesAfter < result.trianglesBefore;

const pass = notCollapsedToNothing && reducedSubstantially && errors.length === 0;
await finish(browser, {
  pass,
  label: 'optimizeModelFile decimates a non-indexed high-poly mesh toward the target budget, not down to nothing (#1682)',
  errors,
});
