// Browser side of the model tiers backfill (#3415, part of #3412). Loaded by
// scripts/backfill-model-tiers-page.html in headless Chromium so the mid and
// far versions are made by exactly the code an upload runs (the 1/7 core, via
// the 2/7 glue), not by a node copy of it: a node three.js has no canvas, so
// it could not keep or downsize a model's textures.
//
// One entry point, window.backfillTiers(base64Glb), resolves to
// { skinned, mid, far } with each tier as base64 or null.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { generateModelTierBlobs } from '/src/catalog/modelTierUpload.js';

const GLB_TYPE = 'model/gltf-binary';

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: GLB_TYPE });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function hasSkinnedMesh(scene) {
  let skinned = false;
  scene.traverse((object) => { if (object.isSkinnedMesh) skinned = true; });
  return skinned;
}

window.backfillTiers = async (base64Glb) => {
  const fullBlob = base64ToBlob(base64Glb);
  let skinned = false;
  const tiers = await generateModelTierBlobs(fullBlob, {
    async parseModel(blob) {
      const gltf = await new GLTFLoader().parseAsync(await blob.arrayBuffer(), '');
      skinned = hasSkinnedMesh(gltf.scene);
      return gltf.scene;
    },
    // A background tab may not get animation frames; a timer always fires.
    nextFrame: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  // A skinned model (an avatar) is not a placed item and is never reduced.
  if (skinned) return { skinned: true, mid: null, far: null };
  return {
    skinned: false,
    mid: tiers.mid ? await blobToBase64(tiers.mid) : null,
    far: tiers.far ? await blobToBase64(tiers.far) : null,
  };
};

window.backfillTiersReady = true;
