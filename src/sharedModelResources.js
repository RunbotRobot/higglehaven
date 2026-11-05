// #1560: loadModelInstance clones the cached GLTF scene per instance, and a
// cloned Mesh still shares its geometry with the cached source (and with
// every other clone), while material.clone() keeps pointing at the same
// Texture objects. The cache keeps that source alive for the whole session,
// so tearing down one instance (a catalog thumbnail render, an axis preview,
// a despawned avatar) must free only what it owns -- its cloned materials --
// not the geometry/textures every other live clone is still drawing with.
// Disposing those anyway forced three.js to re-upload them to the GPU on the
// next frame of every other instance of the same model.
//
// Dependency-free on purpose (duck-typed, no three.js import) so it is unit
// testable under the workerd test pool.
export function markSharedModelResources(mesh) {
  mesh.userData.sharedModelResources = true;
}

// #1560 (cropped instances): loadCroppedModelInstance builds a new Mesh with
// its own cropped geometry (safe to dispose) but gives it a material cloned
// from the cached model, whose texture maps are still the cached source's.
// Such a mesh owns its geometry and shares only its textures.
export function markSharedModelTextures(mesh) {
  mesh.userData.sharedModelTextures = true;
}

export function ownsGeometry(mesh) {
  return !mesh.userData?.sharedModelResources;
}

export function ownsTextures(mesh) {
  return !mesh.userData?.sharedModelResources && !mesh.userData?.sharedModelTextures;
}

export function ownsGeometryAndTextures(mesh) {
  return ownsGeometry(mesh) && ownsTextures(mesh);
}

// The one rule both teardown paths (disposeObject, disposeObject3D) apply to a
// Mesh: materials are always the mesh's own (every instance clones them), but
// geometry and textures are freed only when the mesh owns them.
// `disposeTextures` is the caller's own texture-freeing helper for a material.
export function disposeOwnedMeshResources(mesh, disposeTextures) {
  if (ownsGeometry(mesh)) mesh.geometry?.dispose();
  const freeTextures = ownsTextures(mesh);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    if (!material) continue;
    if (freeTextures) disposeTextures(material);
    material.dispose();
  }
}
