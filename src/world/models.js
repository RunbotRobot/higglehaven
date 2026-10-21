import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cropGeometryFromEnd } from '../meshCrop.js';
import { skeletonSignatureFromBones } from '../skeletonSignature.js';
import { curvedPosition, flatPosition } from '../../worker/earthCurvature.js';
import { activeCatalog, LANDLET_SIDE_M } from './state.js';

// #2553 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the catalog-template -> Object3D
// pipeline and the ground plane -- model loading/caching, the box-fallback
// and crop/extensibility handling, LOD proxies, and dispose helpers, plus
// the one ground-plane Mesh every mode's own scene renders into. Depends
// only on world/state.js (activeCatalog, LANDLET_SIDE_M); `scene` itself
// hasn't been extracted yet (#2552, still in main.js), so this module
// exports `landlet` without adding it to any scene -- main.js does
// `scene.add(landlet)` itself, immediately after this import, preserving
// the exact original initialization order.

// docs/SPEC.md §1's Earth-curvature coordinate system (issue #135): bends
// a flat ground geometry's vertices onto the sphere via worker/
// earthCurvature.js's curvedPosition, treating the mesh's own local origin
// (0,0,0) as the tangent point on Earth's surface — correct for Build
// mode, which always renders a landlet in its own local scene regardless
// of that landlet's true position out in the wider world (unlike Shop
// mode's shared-world view, where curvature between landlets, not just
// within one, matters — a separate, larger piece of #133 this doesn't
// attempt). Genuinely imperceptible at a landlet's ~31.6m scale (see
// clampToLandlet's own comment on this) — this is about the underlying
// geometry being correct, not a visible effect, per #135's own note not
// to over-build visual fidelity here.
export function curveGroundGeometry(geometry) {
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const curved = curvedPosition({ x: position.getX(i), y: position.getY(i), z: position.getZ(i) });
    position.setXYZ(i, curved.x, curved.y, curved.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

// curveGroundGeometry's own inverse for a raycast hit: `landlet`'s
// geometry is now the curved surface, so a hit against it lands on that
// curve rather than the flat plane every other coordinate in this file
// (placement, measuring, clamping) still assumes — convert back via
// flatPosition before any of that math ever sees the point.
export function flatGroundHitPoint(hit) {
  const flat = flatPosition(hit.point);
  return new THREE.Vector3(flat.x, flat.y, flat.z);
}

// #220 (biome ground texture): #219's own real classification-data
// pipeline (worker/geoData.js, scripts/ingest-geo-data.mjs) never actually
// landed a `biome` field on a landlet — it only ever shipped water/
// buildable landType (already given its own distinct look), and its
// ingestion script has never been run against real data at all. Every
// landlet this game currently generates therefore falls into exactly the
// "no real classification" bucket #220 itself calls out needing a
// fallback for — so rather than invent a speculative per-biome system
// with nothing real to key off (the same call PR #238 already made for
// this same issue), this just replaces the flat single-color ground
// fill with a textured "default/unclassified" one.
//
// #2371 (sub-issue of #2368) is that real per-biome lookup, now that
// #2369/#2370 actually landed a `biome` column with real ingested data
// behind it. 'lowland' deliberately keeps the exact same palette as the
// default/unclassified bucket below: it's the common, ordinary case
// (#2370's own real ingestion run classified 87% of its sampled area as
// lowland), not a visual change from today's world. near_water/upland/
// alpine each get their own base color/speckle palette, picked by eye
// against each band's real-world character (marshy/lush near water,
// progressively drier/rockier moving upslope) — the same "lower fidelity
// bar" (docs/SPEC.md §8) every other real-world classification in this
// app already uses, not a precise biome model.
//
// Generated on a canvas rather than loaded from an image asset (matching
// makeDimensionLabelSprite's own CanvasTexture precedent elsewhere in
// this file) — small random dabs in a few close shades over a base fill
// read as mottled ground without needing real art. colorSpace must be
// set explicitly: THREE.Texture defaults to NoColorSpace, which reads a
// canvas's colors washed-out/oversaturated against everything else in
// the scene using the sRGB pipeline.
const DEFAULT_GROUND_TEXTURE_PALETTE = { base: '#6ca42e', speckles: ['#7cb83a', '#5c9424', '#82c244', '#568c20'] };
const GROUND_TEXTURE_PALETTES = {
  near_water: { base: '#4a8f6b', speckles: ['#5aa87d', '#3d7a5a', '#6bc294', '#2f6548'] },
  upland: { base: '#8a9a4a', speckles: ['#9aab56', '#78873c', '#a7b863', '#687532'] },
  alpine: { base: '#9c9488', speckles: ['#aba398', '#8a8276', '#b8b0a4', '#766e64'] },
};
const cachedGroundTextures = new Map(); // palette key ('default' or a real biome) -> CanvasTexture
export function createGroundTexture(biome = null) {
  const key = GROUND_TEXTURE_PALETTES[biome] ? biome : 'default';
  if (cachedGroundTextures.has(key)) return cachedGroundTextures.get(key);
  const { base, speckles } = GROUND_TEXTURE_PALETTES[biome] ?? DEFAULT_GROUND_TEXTURE_PALETTE;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = speckles[i % speckles.length];
    const w = 1 + Math.random() * 2;
    const h = 3 + Math.random() * 4;
    ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, w, h);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 8);
  texture.colorSpace = THREE.SRGBColorSpace;
  cachedGroundTextures.set(key, texture);
  return texture;
}

// THREE.ShapeGeometry's own UV convention is "world uvs" — literally each
// vertex's raw local-space (x, y) in meters, not normalized to [0, 1] the
// way PlaneGeometry/CircleGeometry's UVs are (three.js's own ShapeGeometry
// source: `uvs.push(vertex.x, vertex.y)`). createGroundTexture()'s shared
// texture.repeat (8, 8) was tuned against landletGeometry's PlaneGeometry
// just below, whose UVs really do run 0..1 across its own LANDLET_SIDE_M
// width — applied to a ShapeGeometry instead, those raw-meter UVs make the
// same texture repeat hundreds of times across a landlet-sized shape, far
// more than the GPU's mipmap minification can resolve, which washes the
// whole surface out to a near-flat average color instead of visible grass
// speckle (Control Room: "I see the grass ground texture load, then it
// reverts to the old plain green plane" once applyLandletShape swaps in a
// real landlet's ShapeGeometry). Dividing by LANDLET_SIDE_M puts a
// ShapeGeometry's UVs back in that same "one unit per landlet-width" space
// PlaneGeometry's naturally are, so the shared texture.repeat gives the
// same physical tile density either way.
export function normalizeGroundShapeUVs(geometry) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) / LANDLET_SIDE_M, uv.getY(i) / LANDLET_SIDE_M);
  }
  uv.needsUpdate = true;
}

// PlaneGeometry already lies flat in the XY plane by default — which is
// now our ground plane (Z-up), so unlike before, no rotation is needed. This
// square is only a placeholder shown before bootstrap() resolves which
// landlet is actually being built on — applyLandletShape() (main.js, still
// there pending claim/flow.js's own extraction of shapeForLandlet) swaps
// the geometry for the real polygon once that's known. The mesh itself
// (and its raycasting target) has to exist immediately, since ground-click
// placement can happen before that fetch resolves. Not added to any scene
// here — main.js does `scene.add(landlet)` itself right after importing
// this (see this module's own header comment for why).
const landletGeometry = new THREE.PlaneGeometry(LANDLET_SIDE_M, LANDLET_SIDE_M);
curveGroundGeometry(landletGeometry);
// DoubleSide so the plane stays visible from below during dev orbiting;
// the finished game will never let a shopper get under the ground plane.
const landletMaterial = new THREE.MeshStandardMaterial({ map: createGroundTexture(), side: THREE.DoubleSide });
export const landlet = new THREE.Mesh(landletGeometry, landletMaterial);

export function findTemplate(templateId) {
  return activeCatalog.find((template) => template.templateId === templateId);
}

// Real product models (glTF/.glb — see public/models/ and catalog.js's
// modelUrl fields), not a generic box standing in for every product.
// Loaded once per URL and cached; every placed instance after the first
// gets a clone of the cached scene instead of re-fetching/re-parsing it.
// Cached by the raw parsed GLTF (not just its .scene) so a caller that
// also needs .animations (#682's avatar rig convention — see
// loadModelAnimations below) never triggers a second fetch/parse for the
// same URL.
const gltfLoader = new GLTFLoader();
const modelGltfCache = new Map(); // modelUrl -> Promise<GLTF>

// #2438: a failed load used to cache the REJECTED promise just as
// permanently as a successful one — a single transient failure (a dropped
// request, an R2 read racing right behind the upload that created this
// exact file) poisoned this URL for the rest of the tab's session, since
// every later caller (a second placed instance of the same template, a
// later view of the same product) got handed the same already-rejected
// promise instead of a fresh attempt. Deleting the cache entry the moment
// it rejects — before the rejection ever reaches this call's own caller —
// means only the failing attempt itself sees that rejection; the next call
// for the same url finds the cache empty again and genuinely retries.
function loadModelGltf(url) {
  if (!modelGltfCache.has(url)) {
    modelGltfCache.set(url, gltfLoader.loadAsync(url).catch((err) => {
      modelGltfCache.delete(url);
      throw err;
    }));
  }
  return modelGltfCache.get(url);
}

function loadModelScene(url) {
  return loadModelGltf(url).then((gltf) => gltf.scene);
}

// #682 (sub-issue of #679/#680/#681): the named animation clips (if any)
// an uploaded model carries — idle/walk/fly, per the convention documented
// in docs/SPEC.md's "Avatar rig/animation clip convention" — for
// createCustomShopAvatar to drive via AnimationMixer, and for the upload
// wizard to surface at upload time (showUploadDimensionPreview).
export function loadModelAnimations(url) {
  return loadModelGltf(url).then((gltf) => gltf.animations);
}

// #1162 (sub-issue of #1161, sellable avatar animations): a deterministic
// signature of a model's skeleton — its bone names and parent/child
// hierarchy — computed at upload time (showUploadDimensionPreview) and
// persisted on the catalog template (skeletonSignature) alongside
// modelSizeBytes, so a future standalone animation upload (#1163) and the
// shop/equip UI (#1164) can compare two models' signatures for
// compatibility by simple string equality rather than re-fetching and
// re-parsing both models every time.
//
// Exact equality, not a fuzzy/partial match: Three.js's AnimationMixer
// binds each keyframe track to a bone by name alone, so an animation
// plays correctly against a different file's skeleton only when the two
// skeletons share the exact same bone names in the exact same hierarchy
// — anything looser risks a silently broken retarget (limbs not moving,
// or moving through the wrong pivot) with no error to warn the shopper.
// Root bones (no bone parent — normally just one, a hips/root joint, but
// not assumed) and the rest (as parent>child edges) are each gathered and
// sorted independently so the signature doesn't depend on the order bones
// happen to appear in the file, then hashed to a fixed-length digest —
// compact for storage, and content-opaque since a rig's bone names aren't
// meaningful to store verbatim.
//
// Returns null for a model with no skeleton at all (an ordinary rigid
// prop) — same "nothing to report" shape loadModelAnimations already
// uses for a model with zero animation clips.
//
// #1233: the actual root/edge-sorting-and-hashing logic lives in the pure,
// dependency-free skeletonSignatureFromBones (src/skeletonSignature.js),
// extracted out of this function so it's directly unit-testable in the
// workerd test pool (see vitest.config.js's own note on why code importing
// three.js can't live there) — this function keeps only the three.js-
// dependent part (loading the GLTF, finding the SkinnedMesh).
export async function computeSkeletonSignature(url) {
  const gltf = await loadModelGltf(url);
  let skinnedMesh = null;
  gltf.scene.traverse((child) => {
    if (!skinnedMesh && child.isSkinnedMesh) skinnedMesh = child;
  });
  if (!skinnedMesh) return null;
  return skeletonSignatureFromBones(skinnedMesh.skeleton.bones);
}

// glTF is authored Y-up by convention (whatever tool exported it — Blender,
// etc.) — our scene is Z-up (see camera.up.set above), and nothing about
// loading a glTF file auto-corrects that; the raw vertex data just gets
// used as-is. Wrapping the loaded scene in a container and rotating *that
// inner copy* +90 degrees about X converts "up" from the model's Y to the
// container's Z, so the container's own position/rotation.z then behaves
// exactly like every other product's. This is the real correction any
// future genuine seller-uploaded model will also need, not a shortcut
// specific to these placeholder assets — which is why the placeholder
// models here are deliberately authored in standard Y-up space rather than
// pre-rotated to dodge it.
export async function loadModelInstance(url) {
  const cachedScene = await loadModelScene(url);
  const model = cachedScene.clone();
  // Object3D.clone() shares materials/geometries by reference. Geometry
  // being shared is fine (read-only), but materials need independent
  // copies per instance so a future per-material tweak on one placed
  // instance (recoloring, damage states, etc.) can't leak into every other
  // instance sharing the same cached material.
  model.traverse((child) => {
    if (child.isMesh) {
      child.material = Array.isArray(child.material)
        ? child.material.map((material) => material.clone())
        : child.material.clone();
    }
  });
  model.rotation.x = Math.PI / 2;

  // Every placeholder model in this file is deliberately authored centered
  // on its own local origin, so "z = height / 2 rests it on the ground"
  // (see createMeshForInstance) holds by construction. A real uploaded
  // model can't be trusted to follow that convention — RealityScan (and
  // photogrammetry tools generally) keep whatever pivot the original
  // capture volume had, which does not move back to the geometry's center
  // after cropping away part of a scan. An uncentered model was exactly
  // this: cropping ~1.5in off the bottom of a 3in scan left the remaining
  // geometry sitting off-center relative to its own origin, so the
  // declared (correctly measured) height was right but the visual mesh
  // rendered shifted from where the collision system placed it — the
  // brick appeared to float exactly by the cropped-away amount whenever
  // Snap rested it on the ground. Recentering here, once per loaded
  // instance, makes the convention hold for any model regardless of the
  // source tool's own pivot.
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);

  const container = new THREE.Group();
  container.add(model);
  // #682: the actual loaded node, for a caller (createCustomShopAvatar)
  // that needs to bind a THREE.AnimationMixer to the same hierarchy the
  // model's own animation clips (if any) were authored against — the
  // wrapping container itself was never part of that hierarchy.
  container.userData.model = model;
  return container;
}

// axis ('x'/'y'/'z', matching how BoxGeometry's three arguments map onto
// this scene below) -> { minM } declared by the seller on a template that
// can be shortened, e.g. a brick or lumber board cut down to fit a gap
// (see docs/API.md). Lives in the template's existing metadata_json rather
// than needing its own column — same place `placeholder: true` already
// lives.
export function extensibleAxes(template) {
  return template.metadata?.extensible || null;
}

// The length actually in effect for one axis of an instance: the builder's
// crop override if it has cropped that axis, else the template's full
// (seller-uploaded maximum) size.
export function effectiveLength(template, instance, axis, dimensionKey) {
  return instance.crop?.[axis] ?? template.dimensions[dimensionKey];
}

// A placed mesh's real, current footprint — its template's dimensions with
// any crop (mesh.userData.crop, set in createMeshForInstance) and uniform
// Resize scale (mesh.userData.scale) applied. Collision, landlet-bounds
// clamping, and stacking all need this rather than the template's raw
// dimensions, or a cropped/resized item would still claim its full
// template-declared footprint for those purposes.
export function meshDimensions(mesh) {
  const { template, crop, scale = 1 } = mesh.userData;
  // Every caller here — clampToLandlet's own minimum-z floor, collision
  // resolution, the group-move bounds clamp, alignment assist's own
  // half-extent — needs to agree a flooring mesh is genuinely thin, not
  // whatever height the seller declared for the (unused, for flooring)
  // full-size model. Defined once here rather than special-cased at every
  // call site.
  if (isFlooringTemplate(template)) {
    return { width: template.dimensions.width, depth: template.dimensions.depth, height: FLOORING_THICKNESS_M };
  }
  return {
    width: (crop?.x ?? template.dimensions.width) * scale,
    depth: (crop?.y ?? template.dimensions.depth) * scale,
    height: (crop?.z ?? template.dimensions.height) * scale,
  };
}

// #2378 (docs/SPEC.md §1's near/middle-LOD/far-panoramic-backdrop chunk
// loading, #2377): a cheap box stand-in for a model-loaded instance's full
// geometry, shown at the middle LOD band instead of leaving full detail
// loaded all the way out to the unload radius. Added as an extra child of
// the instance's own object rather than swapping object identity, so every
// other per-object hook (entry.objects, sign/calendar/review registration,
// userData) keeps working completely unchanged — only this proxy's and the
// real model's own children's `.visible`/hit-testable state toggle (see
// setInstanceLodState below, which also establishes the correct initial
// raycast state right after this returns — see its own call site). Box-
// fallback/flooring instances (object.isMesh true, from
// createMeshForInstance's own box-fallback branches) return null here:
// they're already a single cheap box, nothing left to simplify.
export function buildInstanceLodProxy(object) {
  if (object.isMesh) return null;
  const { width, depth, height } = meshDimensions(object);
  const geometry = new THREE.BoxGeometry(width, depth, height);
  const material = new THREE.MeshStandardMaterial({ color: object.userData.template.color });
  const proxy = new THREE.Mesh(geometry, material);
  proxy.visible = false;
  return proxy;
}

// #2399: THREE.Raycaster's own tree walk (see intersect() in its source)
// never checks `.visible` — only `.layers`, and then each object's own
// raycast() return value. A plain no-op raycast override returns
// `undefined`, not `false`, which still lets the walk recurse into that
// object's own children — not enough to hide a real model's top-level
// child when it's often a Group wrapping several meshes, not a single
// Mesh. Returning exactly `false` stops that recursion outright, so a
// hidden object (and everything under it) never contributes a hit;
// deleting our own override restores whatever raycast method that
// object's own class actually defines (Mesh.prototype.raycast, or the
// inert Object3D.prototype.raycast for a plain Group), without having to
// know or store which one that was.
function setLodChildHitTestable(child, hitTestable) {
  if (hitTestable) delete child.raycast;
  else child.raycast = () => false;
}

// #2378: true switches an instance to its simplified middle-band proxy;
// false restores full detail. A no-op for an instance with no proxy
// (buildInstanceLodProxy returned null for it, stored as
// object.userData.lodProxy in loadShopLandletInstances) — a box/flooring
// instance has nothing to switch. Keeps hit-testability in sync with
// visibility on both sides (#2399) — without this, the visible side of a
// switch could tap-miss (invisible proxy/model still absorbing the hit)
// while the hidden side keeps catching every tap meant for whichever
// object the shopper can actually see.
export function setInstanceLodState(object, isMiddle) {
  const proxy = object.userData.lodProxy;
  if (!proxy) return;
  proxy.visible = isMiddle;
  setLodChildHitTestable(proxy, isMiddle);
  for (const child of object.children) {
    if (child === proxy) continue;
    child.visible = !isMiddle;
    setLodChildHitTestable(child, !isMiddle);
  }
}

export const AXIS_DIMENSION_KEY = { x: 'width', y: 'depth', z: 'height' };
export const AXIS_LIST = ['x', 'y', 'z'];

// Ground/flooring products (docs/SPEC.md §3: "placing a specific real
// flooring/sod product replaces [the default grass] within that
// footprint") — a template opts in via metadata.flooring (toggled in the
// Seller modal), not a separate catalog field, the same lightweight
// pattern extensibleAxes already uses for metadata.extensible. Always
// renders as a thin flat plane at true ground level regardless of the
// template's own declared height or whether it has a real uploaded model
// — true texture-masking of the shared ground mesh within an arbitrary
// footprint is a real rendering problem or its own; a thin tinted slab
// reads as "this patch of ground is now this product" without it, the
// same simplification a placeholder box already stands in for any product
// with no real model.
export const FLOORING_THICKNESS_M = 0.02;
export function isFlooringTemplate(template) {
  return template.metadata?.flooring === true;
}

// Downsamples a texture to a single pixel via an offscreen canvas to get
// its overall average color — a cheap, dependency-free way to get "this
// product's actual color" for a real uploaded model, whose catalog
// template.color is usually just the upload flow's generic gray
// placeholder rather than a color anyone actually picked (see
// loadCroppedModelInstance's own use of this). Returns null for a
// materialless mesh or a texture whose image hasn't finished decoding yet
// (shouldn't happen in practice — GLTFLoader resolves textures before a
// model's load promise does — but a null-safe fallback costs nothing).
function averageTextureColor(texture) {
  const image = texture?.image;
  if (!image || !image.width || !image.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color(r / 255, g / 255, b / 255);
}

// For an extensible template that has a real model: loads it via
// loadModelInstance (its usual Y-up-correction/recenter pipeline), then —
// for each axis this particular instance is actually cropped shorter than
// the template's declared maximum on (a template can declare more than
// one extensible axis, see extensibleAxes, though most instances of it
// won't be cropped on all of them at once) — bakes each mesh's
// accumulated transform into its own geometry (putting it in the same
// container-local space effectiveLength's width/depth/height already
// describe) and runs it through meshCrop.js's plane clipper, once per
// cropped axis. Cropping only ever removes material from the +axis end
// (see meshCrop.js's own doc comment for why, and why the far end's cap
// is never a fabricated flat disc) — see docs/API.md's "Extensible
// products" section. Returns the container unmodified when there's
// nothing to crop on any axis, so a full-length instance of an
// extensible template still renders exactly like a normal one, model
// and all.
async function loadCroppedModelInstance(template, instance) {
  const container = await loadModelInstance(template.modelUrl);
  const extensible = extensibleAxes(template);
  if (!extensible) return container;

  const croppedAxes = ['x', 'y', 'z'].filter((axis) => {
    if (!extensible[axis]) return false;
    const dimensionKey = AXIS_DIMENSION_KEY[axis];
    const fullLength = template.dimensions[dimensionKey];
    const cropLength = effectiveLength(template, instance, axis, dimensionKey);
    return cropLength < fullLength - 1e-6;
  });
  if (croppedAxes.length === 0) return container;

  container.updateMatrixWorld(true);
  const meshes = [];
  container.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });

  // Cropping only the +axis end leaves the remaining geometry's true
  // center drifting toward -axis as cropLength shrinks — but every
  // consumer of a placed mesh's own position (collision, landlet-bounds
  // clamping, ...) assumes position IS the center, the same convention
  // the box-fallback and uniformly-Resize-scaled cases already follow by
  // construction. Translating the geometry back by that same drift
  // restores that invariant: `position` continues to mark the true
  // center of whatever's actually rendered, exactly like every other
  // item type. (#272: this used to also push an equal-and-opposite
  // offset onto this inner group, which canceled the translate below
  // back out to a no-op — leaving a cropped real model's rendered
  // footprint silently off-center from what collision/landlet-bounds
  // clamping assumed.) Each cropped axis's own offset is independent of
  // the others (different vector components), so accumulating them into
  // one shift and applying it once, after every axis has been cropped,
  // is equivalent to applying each axis's own shift right after its own
  // crop — simpler to just do once at the end.
  const shift = [0, 0, 0];
  for (const axis of croppedAxes) {
    const axisIndex = { x: 0, y: 1, z: 2 }[axis];
    const dimensionKey = AXIS_DIMENSION_KEY[axis];
    const fullLength = template.dimensions[dimensionKey];
    const cropLength = effectiveLength(template, instance, axis, dimensionKey);
    const recenterOffset = (cropLength - fullLength) / 2;
    shift[axisIndex] = -recenterOffset;
  }

  // The manufactured backing cap (materialIndex 1 — see meshCrop.js) is
  // meant to stay fully hidden behind the real, relocated end cap, but a
  // real scanned cross-section — especially one that isn't a simple
  // rectangular prism — can still leave some of it exposed even after
  // cropGeometryFromEnd's own bounding-box coverage fit, which can only
  // correct a size mismatch, not reshape a patch to a hole's actual
  // (possibly irregular) outline. Rendering that sliver with the SAME
  // textured material as the real surface used to mean sampling whatever
  // texel happens to sit at the flat cap's UV(0,0) — an arbitrary,
  // sometimes bizarrely-colored patch of the product's own texture atlas
  // showing up out of context. template.color is scarcely better for a
  // real uploaded model: it's near-universally the upload flow's generic
  // placeholder swatch (`#999999`), not this product's actual color, so a
  // visible sliver still read as a flat industrial-gray patch rather than
  // "an ordinary surface" of the same product. Sampling the real
  // material's own texture down to its average color instead means any
  // exposed sliver blends into the surrounding real surface's actual tone
  // — still not textured detail, but no longer an obviously wrong color.
  // DoubleSide: a genuinely holey real scan (see this block's own comment
  // above) can let a grazing view ray slip past the backing cap's front
  // face without a clean hit — rendering its normally-invisible backface
  // instead of falling through to empty space/background is a cheap,
  // strictly-better hardening regardless of any one model's own defects.
  const inner = new THREE.Group();
  for (const mesh of meshes) {
    let geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // Cropping two or three axes on the same instance runs this same
    // geometry through cropGeometryFromEnd once per axis in turn — each
    // pass only ever touches its own axis's coordinate, so an
    // already-cropped x range is untouched by a following z crop and
    // vice versa (see cropGeometryFromEnd's own doc comment: it assumes
    // its axis is currently centered at 0, which chaining preserves
    // since a crop on one axis never moves another axis's coordinates).
    // The one real cost of chaining rather than cropping fresh geometry
    // per axis: a later pass's toTriangleList normalizes every triangle
    // it sees back to "real surface," including an earlier pass's own
    // fabricated backing-cap sliver near a shared corner — a small,
    // already-meant-to-be-hidden patch occasionally rendering with the
    // real texture instead of its flat backing color, not the always-
    // preserved surface a builder actually sees.
    for (const axis of croppedAxes) {
      const axisIndex = { x: 0, y: 1, z: 2 }[axis];
      const dimensionKey = AXIS_DIMENSION_KEY[axis];
      const fullLength = template.dimensions[dimensionKey];
      const cropLength = effectiveLength(template, instance, axis, dimensionKey);
      geometry = cropGeometryFromEnd(geometry, axisIndex, cropLength, fullLength);
    }
    geometry.translate(shift[0], shift[1], shift[2]);
    const originalMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const backingColor = averageTextureColor(originalMaterial?.map) || new THREE.Color(template.color);
    const backingMaterial = new THREE.MeshStandardMaterial({ color: backingColor, side: THREE.DoubleSide });
    inner.add(new THREE.Mesh(geometry, [originalMaterial, backingMaterial]));
  }
  const result = new THREE.Group();
  result.add(inner);
  return result;
}

// Builds the Object3D for a placed instance: its catalog template's real
// model if it has one (cropped via loadCroppedModelInstance when the
// template is extensible and this instance actually is cropped), falling
// back to a colored box (still used by any template without a model yet,
// and if a model fails to load or crop). Resting on the ground (z = height
// / 2) by default since a fresh instance has no saved z yet.
//
// BoxGeometry's arguments are always (X-size, Y-size, Z-size) regardless of
// which axis a scene treats as "up" — it has no idea about camera.up. Since
// Z is our vertical axis, `height` (the product's real-world tallness) has
// to go in the third argument, not the second.
export async function createMeshForInstance(instance) {
  const template = findTemplate(instance.templateId);
  if (!template) {
    // Catalog and instance list came from different sources (e.g. one
    // fetched from the API, the other loaded from a stale local cache) and
    // disagree on templateIds. bootstrap() below fetches both together
    // specifically to avoid this, but a defensive skip here is cheap
    // insurance against crashing the whole scene over one bad instance.
    console.warn(`No catalog template "${instance.templateId}" — skipping instance ${instance.instanceId ?? instance.id}`);
    return null;
  }
  if (isFlooringTemplate(template)) {
    // A deliberately separate, much simpler path — no model loading, no
    // crop/extensibility, no uniform-scale legacy handling (none of the
    // Resize/Trim tools apply to flooring — it's always its own declared
    // footprint, always thin, always at the ground). Only x/y and
    // rotationZ from the instance are meaningful; z is always the fixed
    // ground thickness regardless of what's stored (see the
    // objectChange handler's own flooring clamp for why a stale non-zero
    // z from before this feature existed, or a stray drag, can't stick).
    const width = template.dimensions.width;
    const depth = template.dimensions.depth;
    const geometry = new THREE.BoxGeometry(width, depth, FLOORING_THICKNESS_M);
    const material = new THREE.MeshStandardMaterial({ color: template.color });
    const object = new THREE.Mesh(geometry, material);
    object.position.set(instance.x ?? 0, instance.y ?? 0, FLOORING_THICKNESS_M / 2);
    object.rotation.z = instance.rotationZ ?? 0;
    object.userData.instanceId = instance.instanceId ?? instance.id;
    object.userData.template = template;
    object.userData.crop = {};
    object.userData.scale = 1;
    object.userData.label = instance.label ?? null;
    return object;
  }
  const width = effectiveLength(template, instance, 'x', 'width');
  const depth = effectiveLength(template, instance, 'y', 'depth');
  const height = effectiveLength(template, instance, 'z', 'height');
  let object;
  if (template.modelUrl) {
    try {
      object = extensibleAxes(template)
        ? await loadCroppedModelInstance(template, instance)
        : await loadModelInstance(template.modelUrl);
    } catch (err) {
      console.warn(`Failed to load model for "${template.templateId}" (${template.modelUrl}), falling back to a colored box:`, err);
    }
  }
  if (!object) {
    const geometry = new THREE.BoxGeometry(width, depth, height);
    const material = new THREE.MeshStandardMaterial({ color: template.color });
    object = new THREE.Mesh(geometry, material);
  }
  object.position.set(instance.x ?? 0, instance.y ?? 0, instance.z ?? height / 2);
  object.rotation.set(instance.rotationX ?? 0, instance.rotationY ?? 0, instance.rotationZ ?? 0);
  object.userData.instanceId = instance.instanceId ?? instance.id;
  object.userData.template = template;
  object.userData.crop = { ...(instance.crop || {}) };
  // A uniform scale factor, separate from Trim's per-axis crop above.
  // Builders can no longer set this (Resize was removed from Build mode —
  // the world should be populated at each product's real, seller-declared
  // size), but existing instances saved before that change still carry a
  // non-1 value here and must keep rendering at it. Applied to the whole
  // returned object (box fallback or real model container alike) so it
  // scales everything uniformly, position included via Object3D's own
  // transform.
  object.userData.scale = instance.scale ?? 1;
  object.scale.setScalar(object.userData.scale);
  // Community signs (docs/API.md's "Community signs") — a per-instance
  // flag, unlike flooring's per-template one, so it lives on the instance
  // itself rather than being derived from the template. Flooring can't
  // also be a sign (its own branch above never sets this), which is fine —
  // nothing in the spec calls for a flat ground patch to double as one.
  object.userData.isCommunitySign = instance.isCommunitySign ?? false;
  // Community calendar (docs/API.md's "Community calendar") — same
  // per-instance-flag reasoning as isCommunitySign just above, and
  // independent of it.
  object.userData.isCommunityCalendar = instance.isCommunityCalendar ?? false;
  // Not editable anywhere in Build mode yet (#1294) — carried through
  // purely so a value already on the row (set directly via the API)
  // survives being rebuilt into a mesh and round-tripped back out again,
  // the same reasoning as crop/scale/isCommunitySign/isCommunityCalendar
  // just above.
  object.userData.label = instance.label ?? null;
  // #1254: exposes the real rendered bounding-box size of whichever
  // instance's mesh this function last built — e2e-only, same "expose a
  // minimal hook purely for test verification" precedent as
  // window.__friendsMapPoints (#1229). Lets a test confirm meshCrop.js's
  // crop actually shrank the right axis (and left the others untouched)
  // or that rescaleModelFile's uniform rescale actually took effect on the
  // real file, rather than only checking a persisted number.
  const extentBox = new THREE.Box3().setFromObject(object);
  const extentSize = new THREE.Vector3();
  extentBox.getSize(extentSize);
  window.__lastInstanceExtent = {
    instanceId: object.userData.instanceId, x: extentSize.x, y: extentSize.y, z: extentSize.z,
  };
  return object;
}

// #1359: material.dispose() releases the material's own WebGL program/
// uniform resources but never the THREE.Texture instances it references
// (map, normalMap, roughnessMap, ... — any PBR map a real uploaded GLTF/GLB
// can carry). Iterating the material's own properties and disposing
// whatever's a real Texture (duck-typed via isTexture, same idiom sprite
// cleanup elsewhere in this file already uses for .map specifically) covers
// every current and future map property without hardcoding each name.
export function disposeMaterialTextures(material) {
  for (const value of Object.values(material)) {
    if (value?.isTexture) value.dispose();
  }
}

// A product's Object3D might be a single Mesh (the box fallback) or a
// Group wrapping a loaded model's own node hierarchy — traverse either way
// rather than assuming a flat single-mesh shape, since a real seller-
// uploaded model could have any number of parts/materials.
export function disposeObject(object) {
  object.traverse((child) => {
    // #1370: a THREE.Sprite (e.g. a billboard label) is neither isMesh nor
    // does it carry .geometry to dispose — only its SpriteMaterial (and the
    // CanvasTexture that material's own .map holds) needs cleanup, which
    // disposeMaterialTextures already covers generically.
    if (child.isSprite) {
      if (child.material) {
        disposeMaterialTextures(child.material);
        child.material.dispose();
      }
      return;
    }
    if (!child.isMesh) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      disposeMaterialTextures(material);
      material.dispose();
    }
  });
}
