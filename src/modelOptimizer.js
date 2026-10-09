// Shrinks an uploaded model file in the browser — the user's own device
// compute — before it ever reaches the network. This exists because
// Cloudflare Workers' free tier gives a request only ~10ms of CPU time,
// nowhere near enough for mesh decimation or texture recompression, so
// doing this server-side isn't viable on the free tier. The browser has
// no such limit.
//
// Only usable for the direct file-upload path. URL-imports are fetched by
// the Worker itself (see api.js/importModelFromUrl) specifically so the
// file never has to pass through the uploading device — optimizing that
// path would mean routing the bytes back through the browser anyway,
// defeating the point.
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
  const resultBuffer = await gltfExporter.parseAsync(group, { binary: true });
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

    const vertexCount = geometry.attributes.position.count;
    const targetVertexCount = Math.max(3, Math.round(vertexCount * (TARGET_TRIANGLES_PER_MESH / triangleCount)));
    const removeCount = vertexCount - targetVertexCount;
    if (removeCount <= 0) {
      trianglesAfter += triangleCount;
      return;
    }

    const simplified = simplifier.modify(geometry, removeCount);
    geometry.dispose();
    child.geometry = simplified;
    trianglesAfter += countTriangles(simplified);
  });

  onProgress?.('Re-encoding model…');
  const resultBuffer = await gltfExporter.parseAsync(scene, { binary: true, maxTextureSize: MAX_TEXTURE_SIZE });

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
    child.scale.multiplyScalar(scaleFactor);
  }
  const resultBuffer = await gltfExporter.parseAsync(gltf.scene, { binary: true });
  return new Blob([resultBuffer], { type: 'model/gltf-binary' });
}
