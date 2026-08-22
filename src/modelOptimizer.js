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
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';

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
const simplifier = new SimplifyModifier();

function countTriangles(geometry) {
  const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
  return Math.round(count / 3);
}

// SimplifyModifier only ever preserves the geometry attributes named
// 'position', 'uv', 'normal', 'tangent', and 'color' through its
// edge-collapse decimation (see its own source) — any other attribute,
// including a second UV set ('uv1'/'uv2'/'uv3', glTF's TEXCOORD_1/2/3),
// gets silently deleted. A texture bound to one of those channels (not
// unheard of — some export pipelines put a base color or other map on a
// non-zero UV set) would then re-export referencing a UV channel that no
// longer exists on the decimated geometry, which can render solid black
// or garbled rather than the product's real appearance. Detecting that
// upfront and skipping simplification for just that mesh trades away some
// file-size savings on this one mesh for guaranteed-correct appearance,
// rather than risking a visibly broken product to save a few KB.
const TEXTURE_MAP_PROPERTIES = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap'];
function usesNonPrimaryUvChannel(material) {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((mat) =>
    TEXTURE_MAP_PROPERTIES.some((prop) => mat?.[prop] && (mat[prop].channel ?? 0) !== 0),
  );
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

    if (usesNonPrimaryUvChannel(child.material)) {
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
