// #1162/#1233: the pure, dependency-free half of computeSkeletonSignature
// (src/main.js) — deriving a deterministic signature from a model's
// skeleton bone names/hierarchy, extracted the same way flight.js/
// settings.js already are so it's directly unit-testable in the workerd
// test pool (see vitest.config.js's own note on the real constraint: a
// loaded model/rendering pipeline, not "imports three.js" itself). Takes
// plain {name, parent, isBone}-shaped bone
// objects, duck-typed the same way computeSkeletonSignature's own real
// THREE.Bone instances already satisfy this shape, so a test can hand-build
// a bone hierarchy with no three.js import at all.
//
// Exact equality, not a fuzzy/partial match: Three.js's AnimationMixer
// binds each keyframe track to a bone by name alone, so an animation plays
// correctly against a different file's skeleton only when the two
// skeletons share the exact same bone names in the exact same hierarchy —
// anything looser risks a silently broken retarget (limbs not moving, or
// moving through the wrong pivot) with no error to warn the shopper. Root
// bones (no bone parent — normally just one, a hips/root joint, but not
// assumed) and the rest (as parent>child edges) are each gathered and
// sorted independently so the signature doesn't depend on the order bones
// happen to appear in, then hashed to a fixed-length digest — compact for
// storage, and content-opaque since a rig's bone names aren't meaningful
// to store verbatim.
export async function skeletonSignatureFromBones(bones) {
  const roots = bones.filter((bone) => !bone.parent?.isBone).map((bone) => bone.name).sort();
  const edges = bones.filter((bone) => bone.parent?.isBone).map((bone) => `${bone.parent.name}>${bone.name}`).sort();
  const canonical = JSON.stringify({ roots, edges });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
