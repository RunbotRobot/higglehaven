// #3414 (Model tiers 2/7, part of #3412): uploading a model through the wizard
// now stores two simpler versions of it beside the full one, with no extra
// step for the seller, and the created product names all three. A model too
// small to reduce still uploads and creates a product (it just has no tiers).
//
// The dense fixture is built here (a high-poly sphere, over the optimiser's
// per-mesh budget so the tiers are genuinely smaller than the full file);
// public/models/crate.glb is the repo's small, already-cheap model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

// Node has no FileReader -- GLTFExporter's binary path uses it.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMALL_MODEL = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const dense = new THREE.Scene();
dense.add(new THREE.Mesh(new THREE.SphereGeometry(1, 120, 120), new THREE.MeshStandardMaterial({ color: '#c0392b' })));
const denseBuffer = Buffer.from(await new GLTFExporter().parseAsync(dense, { binary: true }));

const LABEL = 'Model Tiers Upload Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

const modelUploads = [];
const createRequests = [];
const createResponses = [];
page.on('request', (request) => {
  const url = new URL(request.url());
  if (request.method() === 'POST' && url.pathname === '/api/models') modelUploads.push(url.searchParams.get('tier'));
  if (request.method() === 'POST' && url.pathname === '/api/catalog') {
    try { createRequests.push(JSON.parse(request.postData())); } catch { /* not JSON */ }
  }
});
page.on('response', async (response) => {
  const url = new URL(response.url());
  if (response.request().method() === 'POST' && url.pathname === '/api/catalog' && response.ok()) {
    createResponses.push(await response.json().catch(() => null));
  }
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

async function uploadAndCreate(name, file) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', file);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 90000 });
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

const objectSize = (url) => page.evaluate(async (target) => {
  const response = await fetch(target);
  return response.ok ? (await response.arrayBuffer()).byteLength : -1;
}, url);

// 1. A dense model: three objects stored, the product names all three.
await uploadAndCreate('Dense Tier Product', { name: 'dense-sphere.glb', mimeType: 'model/gltf-binary', buffer: denseBuffer });
const denseUploads = [...modelUploads];
console.log('model uploads for the dense model, in order (should be full, mid, far):', JSON.stringify(denseUploads));
const body = createRequests.find((request) => request.name === 'Dense Tier Product');
const created = createResponses.find((response) => response?.template?.name === 'Dense Tier Product')?.template;
console.log('create request tiers:', body?.modelUrl, body?.modelMidUrl, body?.modelFarUrl);
console.log('stored product tiers:', created?.modelUrl, created?.modelMidUrl, created?.modelFarUrl);

const distinct = body && new Set([body.modelUrl, body.modelMidUrl, body.modelFarUrl]).size === 3;
const allUploads = body && [body.modelUrl, body.modelMidUrl, body.modelFarUrl].every((url) => typeof url === 'string' && url.startsWith('/uploads/models/'));
const fullSize = body ? await objectSize(body.modelUrl) : -1;
const midSize = body?.modelMidUrl ? await objectSize(body.modelMidUrl) : -1;
const farSize = body?.modelFarUrl ? await objectSize(body.modelFarUrl) : -1;
console.log('stored sizes full/mid/far (each tier should be smaller than the one above):', fullSize, midSize, farSize);
const sizesOrdered = fullSize > 0 && midSize > 0 && farSize > 0 && midSize < fullSize && farSize < midSize;
const productNamesAll = created?.modelMidUrl === body?.modelMidUrl && created?.modelFarUrl === body?.modelFarUrl && !!created?.modelMidUrl;

// 2. A model too small to reduce still uploads and creates a product.
modelUploads.length = 0;
await uploadAndCreate('Small Model Product', SMALL_MODEL);
const small = createResponses.find((response) => response?.template?.name === 'Small Model Product')?.template;
console.log('small model: product created (should be true):', !!small, '| uploads:', JSON.stringify(modelUploads), '| tiers:', small?.modelMidUrl, small?.modelFarUrl);

const pass =
  JSON.stringify(denseUploads) === JSON.stringify([null, 'mid', 'far']) &&
  distinct && allUploads && sizesOrdered && productNamesAll &&
  !!small && small.modelUrl?.startsWith('/uploads/models/') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'the upload wizard stores mid and far versions beside the full model and the product names them; a tiny model still uploads (#3414)',
  errors,
});
