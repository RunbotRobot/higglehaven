// Shrinks an uploaded model file in the browser — the user's own device
// compute — before it ever reaches the network. This exists because
// Cloudflare Workers' free tier gives a request only ~10ms of CPU time,
// nowhere near enough for mesh decimation or texture recompression, so
// doing this server-side isn't viable on the free tier. The browser has
// no such limit.
//
// #1621: a URL-import mode used to exist (the Worker fetching a link
// server-side) and would have bypassed this pipeline entirely, since the
// browser never saw the bytes -- but it was removed outright (see
// worker/lib/models.js's handleModelUpload, "A URL-import mode ... used to
// live here too, dropped for now") over SSRF exposure and because few
// real links were directly fetchable anyway. It's gone, not just unused,
// so there is no longer any model-ingestion path in this codebase that
// skips this pipeline: every source -- a direct file pick, an .fbx
// conversion (convertFbxToGlb below), and the video-to-3D generation
// pipeline (worker/lib/video-generation.js's storeTripoModelOutput, #1619)
// -- ends up back in the browser as an ordinary fetchable /uploads/... URL
// and goes through optimizeModelFile the same way a picked file does (see
// src/main.js's handleUploadFileStep, which the video-to-3D entry point
// feeds a synthetic File the same way) before POST /api/models ever sees
// it. A raw video-to-3D mesh is exactly the "undecimated photogrammetry
// mesh in the hundreds of thousands [of vertices]" case
// LARGE_MESH_VERTEX_WARNING_THRESHOLD below already anticipates.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
// A locally patched copy, not the stock addon — see its own doc comment.
// The stock SimplifyModifier silently drops any geometry attribute outside
// position/uv/normal/tangent/color, including a secondary UV set some
// export pipelines put a texture on; this one carries uv1/uv2/uv3 through
// decimation too; see git history for the version of this file that
// instead detected and skipped simplifying those meshes entirely.
import { SimplifyModifier } from './vendor/SimplifyModifierExtraUV.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Real-time web/mobile products should be tiny (see catalog.js's own
// comments) — a few thousand triangles is already generous detail for
// something viewed from a few meters away in-world. Applied per-mesh,
// not to the model as a whole, so a multi-part model doesn't get starved
// by budget spent on its least important piece.
const TARGET_TRIANGLES_PER_MESH = 8000;
const MAX_TEXTURE_SIZE = 1024;

// SimplifyModifier's edge-collapse search is roughly O(vertices) per
// removal, so total cost is roughly O(vertices removed x vertices) — fine
// for tens of thousands of vertices, but a raw, undecimated photogrammetry
// mesh in the hundreds of thousands (or millions) could take a genuinely
// long time on a phone. There's no good way to know how long without
// trying, so this is surfaced as a warning rather than a refusal.
const LARGE_MESH_VERTEX_WARNING_THRESHOLD = 150000;

// #2744: SimplifyModifier's edge-collapse algorithm (both the stock one and
// this file's own vendored copy) has no topology-preserving guarantee -- it
// can and does tear real holes (new boundary edges in a previously closed
// mesh) into the result once a single pass removes too large a fraction of
// a mesh's vertices at once. Confirmed empirically (not theoretically) with
// a standalone probe against several unrelated closed shapes (TorusKnot,
// Sphere, Cylinder): all stayed hole-free up through a 60% single-pass
// removal, and all but Sphere (the least topologically complex of the
// three) had started tearing by 65-70%. A single mesh that's drastically
// larger than TARGET_TRIANGLES_PER_MESH -- e.g. a dense, non-skinned
// character/prop mesh -- would otherwise need exactly this kind of
// extreme single-pass ratio to hit the target in one modify() call. Same
// "optimization is a nice-to-have, not a requirement" tradeoff this file
// already makes for a skinned mesh (#1552) and a thrown simplifier error
// (see this function's own caller in main.js): capping how much a single
// pass may remove means an extremely dense mesh comes out larger than
// TARGET_TRIANGLES_PER_MESH rather than risking visible holes to hit it.
const MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION = 0.6;

const gltfLoader = new GLTFLoader();
const gltfExporter = new GLTFExporter();
const fbxLoader = new FBXLoader();
const simplifier = new SimplifyModifier();

function countTriangles(geometry) {
  const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
  return Math.round(count / 3);
}

// #1166: lets a seller pick a plain .fbx (e.g. a Mixamo character) in the
// upload wizard with no Blender step required. Runs entirely in the
// uploading seller's own browser -- only the resulting .glb ever reaches
// the server, matching optimizeModelFile's own "the Worker's free-tier
// ~10ms CPU budget can't do this" reasoning above, and keeping storage
// format exactly as it already is (.glb only, never .fbx).
//
// FBXLoader.parse() is synchronous and can throw outright on a variant it
// doesn't handle -- unlike optimizeModelFile's optimization step, a failure
// here leaves nothing usable to fall back to (there's no original .glb
// underneath an .fbx pick), so the caller must treat a thrown error as
// fatal to this upload attempt, not a degrade-gracefully case.
export async function convertFbxToGlb(file, onProgress) {
  onProgress?.('Reading file…');
  const arrayBuffer = await file.arrayBuffer();

  onProgress?.('Converting from FBX…');
  // Empty path (second arg): matches gltfLoader.parseAsync's own use below
  // -- there's no server URL for FBXLoader to resolve a relative external
  // texture reference against here, so an .fbx whose textures aren't
  // embedded in the file itself may convert without them. Geometry,
  // skeleton, and animation data (none of which depend on that path) carry
  // over regardless.
  const group = fbxLoader.parse(arrayBuffer, '');

  onProgress?.('Re-encoding as glTF…');
  // #2744: GLTFExporter only writes the animation clips it's explicitly
  // handed via options.animations -- it never reads them off the source
  // object itself, so omitting this silently drops every clip FBXLoader
  // attached to `group.animations` (Mixamo and similar rigs always carry
  // theirs this way), even though the skeleton/geometry convert over fine.
  const resultBuffer = await gltfExporter.parseAsync(group, { binary: true, animations: group.animations });
  return new Blob([resultBuffer], { type: 'model/gltf-binary' });
}

// onProgress(status) is called with short human-readable status strings as
// the pipeline moves through its stages, so the caller can show something
// other than a frozen-looking screen during the (synchronous, potentially
// slow) decimation step.
export async function optimizeModelFile(file, onProgress) {
  onProgress?.('Reading file…');
  const arrayBuffer = await file.arrayBuffer();

  onProgress?.('Parsing model…');
  const gltf = await gltfLoader.parseAsync(arrayBuffer, '');
  const scene = gltf.scene;

  let largestMeshVertexCount = 0;
  scene.traverse((child) => {
    if (child.isMesh) largestMeshVertexCount = Math.max(largestMeshVertexCount, child.geometry.attributes.position.count);
  });
  if (largestMeshVertexCount > LARGE_MESH_VERTEX_WARNING_THRESHOLD) {
    onProgress?.(`Reducing a large model (${largestMeshVertexCount.toLocaleString()} vertices) — this may take a while…`);
    // Let the status text above actually paint before the main thread
    // blocks on simplification — otherwise the browser may never get a
    // chance to render it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  } else {
    onProgress?.('Reducing model detail…');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  let trianglesBefore = 0;
  let trianglesAfter = 0;

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry;
    const triangleCount = countTriangles(geometry);
    trianglesBefore += triangleCount;

    if (triangleCount <= TARGET_TRIANGLES_PER_MESH) {
      trianglesAfter += triangleCount;
      return;
    }

    // #1552: SimplifyModifier's attribute whitelist doesn't carry skin
    // binding through edge-collapse, so decimating a SkinnedMesh silently
    // destroys its skinIndex/skinWeight -- breaking equip/animation
    // playback with no error surfaced anywhere. Same "optimization is a
    // nice-to-have, not a requirement" fallback as a thrown simplifier
    // error (see this function's own caller in main.js): leave a skinned
    // mesh undecimated rather than risk its rig.
    if (geometry.attributes.skinIndex || geometry.attributes.skinWeight) {
      trianglesAfter += triangleCount;
      return;
    }

    // #1682: removeCount must land in the same units simplifier.modify()
    // actually operates on. It always merges duplicate vertices internally
    // before collapsing (SimplifyModifierExtraUV.js's own mergeVertices
    // call) -- a no-op for an already-indexed mesh, but a non-indexed one
    // (one vertex per triangle corner, no sharing) has a raw
    // position.count far larger than its real unique-vertex working set.
    // Without this, removeCount is computed against that inflated raw
    // count and can vastly overshoot the actual mergeable vertices,
    // decimating the mesh down to nothing instead of ~TARGET_TRIANGLES_PER_MESH.
    const mergedForCount = mergeVertices(geometry);
    const vertexCount = mergedForCount.attributes.position.count;
    mergedForCount.dispose();
    const targetVertexCount = Math.max(3, Math.round(vertexCount * (TARGET_TRIANGLES_PER_MESH / triangleCount)));
    const uncappedRemoveCount = vertexCount - targetVertexCount;
    if (uncappedRemoveCount <= 0) {
      trianglesAfter += triangleCount;
      return;
    }
    // #2744: see MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION's own comment --
    // don't let one mesh's removeCount exceed the empirically-safe
    // single-pass ratio just to hit TARGET_TRIANGLES_PER_MESH exactly.
    const removeCount = Math.min(uncappedRemoveCount, Math.floor(vertexCount * MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION));

    const simplified = simplifier.modify(geometry, removeCount);
    geometry.dispose();
    child.geometry = simplified;
    trianglesAfter += countTriangles(simplified);
  });

  onProgress?.('Re-encoding model…');
  // #2744: same reasoning as convertFbxToGlb's own comment above --
  // GLTFExporter never pulls animation clips off the source scene on its
  // own, so leaving options.animations unset here silently discarded every
  // clip gltfLoader.parseAsync just handed back as `gltf.animations`
  // (docs/SPEC.md's "Avatar rig/animation clip convention" idle/walk/fly
  // clips among them) on every single upload, regardless of model size --
  // the skeleton/geometry itself survives re-export fine, so nothing else
  // here ever surfaced this as a failure. An equipped custom avatar with
  // real clips therefore always rendered correctly but never animated,
  // moving only as a rigid whole via root motion.
  const resultBuffer = await gltfExporter.parseAsync(scene, { binary: true, maxTextureSize: MAX_TEXTURE_SIZE, animations: gltf.animations });

  return {
    blob: new Blob([resultBuffer], { type: 'model/gltf-binary' }),
    trianglesBefore,
    trianglesAfter,
    bytesBefore: file.size,
    bytesAfter: resultBuffer.byteLength,
  };
}

// Bakes a uniform scale into a model file's own geometry, permanently
// changing its real-world size rather than just how it's labeled.
//
// Every consumer of a catalog template's dimensions — createMeshForInstance
// (footprint/collision math) and especially loadCroppedModelInstance
// (which cuts an extensible axis at an *absolute* meter offset taken
// straight from template.dimensions, in the model's own local coordinate
// space) — assumes a template's declared width/depth/height are exactly
// the loaded model's own rendered size. If a seller's confirmed dimensions
// (see main.js's upload dimensions step) differ from the model's raw
// measured size, that assumption breaks: the declared size would be right
// but the visible model — and any crop math — would silently stay at the
// old size. Rescaling the actual file here, once, at upload time keeps
// that "declared == rendered" invariant true everywhere else without
// touching any of that other code.
//
// Scaling each top-level child's own .scale (rather than the root
// THREE.Scene's) is deliberate: a bare Scene has no transform in the glTF
// spec, so GLTFExporter has nothing to write a scale onto for one — every
// *node* under it does, which is what each of scene.children actually is.
export async function rescaleModelFile(file, scaleFactor) {
  const arrayBuffer = await file.arrayBuffer();
  const gltf = await gltfLoader.parseAsync(arrayBuffer, '');
  for (const child of gltf.scene.children) {
    // #1583: scaling only .scale is correct for a single root (anchored at
    // its own local origin), but leaves multiple sibling roots' relative
    // offsets fixed instead of scaling with them — a multi-part model (or
    // a Mixamo-style rig, whose Armature/SkinnedMesh are separate sibling
    // roots) would drift apart or overlap instead of scaling as a whole.
    child.position.multiplyScalar(scaleFactor);
    child.scale.multiplyScalar(scaleFactor);
  }
  // #2744: same reasoning as optimizeModelFile's own comment above --
  // GLTFExporter needs animation clips passed explicitly, or re-exporting
  // the scene (as this rescale step always does) silently drops them.
  const resultBuffer = await gltfExporter.parseAsync(gltf.scene, { binary: true, animations: gltf.animations });
  return new Blob([resultBuffer], { type: 'model/gltf-binary' });
}
