// Stores a product's reduced models beside its full one (#3414, Model tiers
// 2/7, part of #3412). The tiers themselves are built by src/modelTiers.js
// (#3413); this module is the seller-side glue: turn the optimised model into
// its mid and far .glb files, upload them, and hand back the two URLs the
// product will name.
//
// Everything here is best effort. A model the builder declines (a skinned
// avatar, one already small enough) simply has no tier of that kind, and any
// failure along the way leaves the product with fewer tiers, never with a
// failed upload: the viewer falls back to the full model for a missing tier.
//
// The browser-only pieces (parse a .glb, export one, wait for a frame) are
// injectable so the orchestration can be tested without a canvas.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildModelTiers, MID_TEXTURE_MAX_SIZE } from '../modelTiers.js';
import { rescaleModelFile } from '../modelOptimizer.js';
import { uploadModelFile } from '../api.js';

const GLB_TYPE = 'model/gltf-binary';

async function nextAnimationFrame() {
  if (typeof requestAnimationFrame === 'function') {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const defaultDeps = {
  async parseModel(blob) {
    const gltf = await new GLTFLoader().parseAsync(await blob.arrayBuffer(), '');
    return gltf.scene;
  },
  async exportGlb(object, options) {
    const buffer = await new GLTFExporter().parseAsync(object, { binary: true, ...options });
    return new Blob([buffer], { type: GLB_TYPE });
  },
  buildTiers: buildModelTiers,
  nextFrame: nextAnimationFrame,
  rescale: rescaleModelFile,
  upload: uploadModelFile,
  fetchBlob: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not read ${url}`);
    return response.blob();
  },
};

// Builds the mid and far versions of an optimised full model and returns
// { mid, far } as Blobs, each null when there is nothing worth storing: the
// builder returned the full model itself, or the exported file is not smaller
// than the full one (the server refuses a reduction that is no smaller).
export async function generateModelTierBlobs(fullBlob, { onProgress, ...overrides } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  onProgress?.('Preparing distance versions…');
  const scene = await deps.parseModel(fullBlob);
  const tiers = await deps.buildTiers(scene, { nextFrame: deps.nextFrame });
  const out = { mid: null, far: null };
  for (const [name, tier, options] of [
    ['mid', tiers.mid, { maxTextureSize: MID_TEXTURE_MAX_SIZE }],
    ['far', tiers.far, {}],
  ]) {
    if (!tier || tier.sharesFullModel) continue;
    const blob = await deps.exportGlb(tier.object, options);
    if (blob.size > 0 && blob.size < fullBlob.size) out[name] = blob;
  }
  return out;
}

// Generates and uploads the tiers of a full model that is already stored.
// Resolves to { modelMidUrl, modelFarUrl } with null for any tier that could
// not be made or stored; it never rejects.
export async function createAndUploadModelTiers(fullBlob, fullSizeBytes, { onProgress, shouldContinue, ...overrides } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const result = { modelMidUrl: null, modelFarUrl: null };
  try {
    const blobs = await generateModelTierBlobs(fullBlob, { onProgress, ...overrides });
    for (const [name, field] of [['mid', 'modelMidUrl'], ['far', 'modelFarUrl']]) {
      if (!blobs[name]) continue;
      if (shouldContinue && !shouldContinue()) return result;
      try {
        const stored = await deps.upload(new File([blobs[name]], `${name}.glb`, { type: GLB_TYPE }), { tier: name });
        if (stored.sizeBytes < fullSizeBytes) result[field] = stored.modelUrl;
      } catch (err) {
        console.warn(`Could not store the ${name} version of the model; continuing without it:`, err);
      }
    }
  } catch (err) {
    console.warn('Could not prepare distance versions of the model; continuing without them:', err);
  }
  return result;
}

// A seller who resizes a product rescales its full model (rescaleModelFile
// bakes the scale into the file), so its reduced versions have to follow or
// they would draw at the old size. Each tier is rescaled by the same factor and
// stored again; a tier that fails or would no longer be smaller than the new
// full model is dropped. Resolves to { modelMidUrl, modelFarUrl }; never rejects.
export async function rescaleAndUploadModelTiers({ modelMidUrl, modelFarUrl }, scaleFactor, fullSizeBytes, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const result = { modelMidUrl: null, modelFarUrl: null };
  for (const [name, field, url] of [['mid', 'modelMidUrl', modelMidUrl], ['far', 'modelFarUrl', modelFarUrl]]) {
    if (!url) continue;
    try {
      const rescaled = await deps.rescale(await deps.fetchBlob(url), scaleFactor);
      const stored = await deps.upload(new File([rescaled], `${name}.glb`, { type: GLB_TYPE }), { tier: name });
      if (stored.sizeBytes < fullSizeBytes) result[field] = stored.modelUrl;
    } catch (err) {
      console.warn(`Could not resize the ${name} version of the model; continuing without it:`, err);
    }
  }
  return result;
}
