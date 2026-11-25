// #4345: the one definition of the largest model file a seller can upload, read by the Worker (which refuses a file
// over it) and by the Add a product step (which says so before sending anything). A copy on each side could drift.
//
// 20MB is a generous ceiling above typical real-world model sizes (most uploads should land well under 2MB), not a
// target: it exists to reject an accidentally-huge raw photogrammetry export before it ever reaches R2.
export const MAX_MODEL_BYTES = 20 * 1024 * 1024;

// What a seller reads when a file is over it. The size is the file's own, after the browser has reduced it.
export function modelTooLargeMessage(sizeLabel, limitLabel) {
  return `This model is ${sizeLabel} after reducing it, over the ${limitLabel} limit. Try a simpler model, or fewer or smaller textures.`;
}

// Only .glb and .fbx files can be made into a product.
export function isUploadableModelName(name) {
  return /\.(glb|fbx)$/i.test(String(name || ''));
}
