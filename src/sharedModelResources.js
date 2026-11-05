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

export function ownsGeometryAndTextures(mesh) {
  return !mesh.userData?.sharedModelResources;
}
