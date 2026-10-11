// #1583: rescaleModelFile scaled each top-level root node's .scale but
// never its .position, so a multi-root model's siblings kept their original
// relative offsets instead of scaling with the rest of the model.
//
// This can't be exercised by driving the real upload wizard UI: every file
// that completes handleUploadFileStep's optimizeModelFile call first (the
// normal path) gets re-exported by GLTFExporter, which unconditionally
// wraps whatever Group it's given in one new top-level node -- so by the
// time rescaleModelFile itself ever runs on that file, an originally
// multi-root model has already been collapsed to a single root one level
// up, and scaling that one wrapper's .scale (without touching its already-
// zero .position) is not buggy at all. Confirmed empirically while writing
// this test: driving the upload wizard end-to-end with a genuinely
// multi-root fixture produced an identical result with and without the
// fix, because the fixture had already been collapsed to one root by
// optimizeModelFile before rescaleModelFile ever saw it.
//
// So this calls rescaleModelFile directly instead (window.__rescaleModelFileForTests,
// added for this issue), feeding it the raw multi-root fixture buffer —
// bypassing optimizeModelFile and exercising the exact branch the bug
// report describes (also the real path for a file optimizeModelFile failed
// to process and fell back to uploading unchanged, per that function's own
// try/catch).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { launchPage, finish } from './helpers.mjs';

// Node has no FileReader -- GLTFLoader's own binary (.glb) parse path uses
// it internally. Same minimal polyfill used throughout this issue's own
// manual verification scripts.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MULTIROOT_MODEL_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-multiroot-offset.glb');
const SCALE_FACTOR = 2;
// Authored directly in the fixture: RootA at local x=0.1, RootB at x=0.6.
const ORIGINAL_ROOT_GAP = 0.5;

const { browser, page, errors } = await launchPage();

const originalBase64 = fs.readFileSync(MULTIROOT_MODEL_PATH).toString('base64');

const rescaledBase64 = await page.evaluate(async ({ base64, scaleFactor }) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'model/gltf-binary' });
  const rescaledBlob = await window.__rescaleModelFileForTests(blob, scaleFactor);
  const buffer = await rescaledBlob.arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}, { base64: originalBase64, scaleFactor: SCALE_FACTOR });

const rescaledBuffer = Buffer.from(rescaledBase64, 'base64').buffer;
const gltfLoader = new GLTFLoader();
const reloaded = await gltfLoader.parseAsync(rescaledBuffer, '');

// World position (not local .position), traversing the whole hierarchy
// rather than assuming a fixed depth: GLTFExporter wraps the exported
// Group in its own extra top-level node, so RootA/RootB end up one level
// deeper than they started as direct children of the original scene.
reloaded.scene.updateMatrixWorld(true);
const meshWorldPositions = [];
reloaded.scene.traverse((child) => {
  if (child.isMesh) {
    const pos = child.getWorldPosition(new THREE.Vector3());
    meshWorldPositions.push({ name: child.name, x: pos.x, y: pos.y, z: pos.z });
  }
});
console.log('rescaled model mesh world positions (should be 2 meshes, ~1.0m apart after a 2x scale from an original 0.5m gap):', meshWorldPositions);

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

const TOLERANCE_RATIO = 0.01; // pure geometry math, no rendered-mesh slack needed
const hasTwoMeshes = meshWorldPositions.length === 2;
const rootGapScaledCorrectly = hasTwoMeshes &&
  Math.abs(distance(meshWorldPositions[0], meshWorldPositions[1]) / ORIGINAL_ROOT_GAP - SCALE_FACTOR) < TOLERANCE_RATIO;

const pass = hasTwoMeshes && rootGapScaledCorrectly && errors.length === 0;
await finish(browser, {
  pass,
  label: "rescaleModelFile scales a multi-root model's sibling roots as a cohesive whole, not just each root's own size (#1583)",
  errors,
});
