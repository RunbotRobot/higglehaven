// Turns a loaded three.js model into its two cheaper versions (#3413, part of
// #3412 "Real models at every distance"):
//
//   mid: about a tenth of the triangles, materials kept, textures downsized.
//   far: tens to about two hundred triangles for the whole model, meshes
//        merged into one, colour baked into vertex colours, one material, no
//        textures. It keeps the item's silhouette and colour, which is what
//        reads from altitude.
//
// No DOM, no network, no module-level side effects: it runs in the seller's
// browser at upload, in the viewer's browser for a product whose tiers do
// not exist yet, and in node for the backfill. Anything that needs a canvas
// (reading a decoded image's pixels) is injectable and degrades to "leave
// the texture alone" when there is none.
//
// The work is chunkable (#3396): modelTierSteps is a generator that yields
// after every simplification pass, and buildModelTiers runs it inside a
// per-slice time budget, handing control back between slices. A single
// simplification pass is not interruptible, so the budget is "stop after the
// pass that crossed it".
//
// Rules shared with the upload optimiser, through geometrySimplify.js:
//   - a skinned mesh is never touched (#1552), so a model that contains one
//     is returned as itself for both tiers;
//   - one pass never removes more than the safe fraction of a mesh (#2744),
//     so reaching a small target takes several passes, each checked for a
//     degenerate result.
// The result is never empty and never a stand-in box: a model too small to
// simplify, or one this module declines to touch, returns its own geometry.
import {
  Box3,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  CanvasTexture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import { silhouetteFidelity, isFaithful } from './tierFidelity.js';
import {
  boundaryEdgeCountSteps, countTriangles, isSkinnedGeometry, simplifyGeometryOnePassSteps,
  MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION,
} from './geometrySimplify.js';

// ---- Tunables (one place, so the leaves that measure and tune them agree) ----

// Mid: roughly a tenth of the full model's triangles, kept inside a floor
// (below it a small model just keeps its own geometry) and a ceiling (a
// very dense model is still capped, since mid is for middle distance).
export const MID_TRIANGLE_FRACTION = 0.1;
export const MID_MIN_TRIANGLES = 48;
export const MID_MAX_TRIANGLES = 4000;
// No single part of a mid model is cut below this many triangles, so a
// multi-part model's small parts are not reduced to slivers.
export const MID_MIN_TRIANGLES_PER_MESH = 12;
// #4062: a mid version that does not still read as the model (src/tierFidelity.js: the silhouette from
// the six axes) is thrown away and a gentler one is tried: this fraction of the triangles, then the next.
// A model that fails every rung keeps its own geometry for mid. The target ceiling grows with each rung.
export const MID_FRACTION_LADDER = [MID_TRIANGLE_FRACTION, 0.25, 0.5];
export const MID_TEXTURE_MAX_SIZE = 256;
// Directions the far fallback (the support hull) takes its extreme points in: the six axes, twelve
// edges and eight corners of a box, so the hull has at most 26 points and about fifty triangles.
const HULL_DIRECTIONS = (() => {
  const dirs = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) dirs.push(new Vector3(x, y, z).normalize());
  return dirs;
})();

// Far: a few dozen to about two hundred triangles for the whole model.
export const FAR_TRIANGLE_FRACTION = 0.01;
export const FAR_MIN_TRIANGLES = 24;
export const FAR_MAX_TRIANGLES = 200;
// Fewest triangles one part keeps in the far model. When a model has more
// parts than the budget can give this to, the smallest parts (by bounding
// volume) are left out of the far model; the bounding-box fit below keeps
// the overall extent right.
export const FAR_MIN_TRIANGLES_PER_MESH = 4;
// The far model's bounding box must stay within this fraction of the full
// model's box diagonal on every side, so an item does not visibly shrink or
// grow when it changes tier. Past it, the far geometry is refitted exactly.
export const FAR_BBOX_TOLERANCE = 0.03;

// Simplification stops when a pass removes less than this fraction of what
// is left (it is stuck), or after this many passes.
const MAX_SIMPLIFY_PASSES = 12;
// #3528: how much of a mesh one pass may remove, tried in this order: the
// simplifier's own cap, then a gentler pass if that one tore the mesh.
const PASS_REMOVAL_FRACTIONS = [MAX_SINGLE_PASS_VERTEX_REMOVAL_FRACTION, 0.2];
// A pass may add this many hole edges before it counts as a tear (rounding in
// the weld, not a real hole).
const HOLE_TOLERANCE_EDGES = 2;
const MIN_PASS_PROGRESS = 0.98;
// A pass that leaves fewer triangles than this is treated as degenerate
// (#2744) and discarded in favour of the previous result.
const MIN_RESULT_TRIANGLES = 4;

// Colour baking: a mesh with at least this many vertices is sampled from its
// texture at each vertex; a sparser one would only catch a few texels, so it
// uses the texture's mean colour instead.
const TEXTURE_SAMPLE_MIN_VERTICES = 200;
const TEXTURE_MEAN_GRID = 16;
const FALLBACK_BASE_COLOR = 0xcccccc;

// Time slice for buildModelTiers: stop and hand control back after the
// simplification pass that crosses this.
export const DEFAULT_FRAME_BUDGET_MS = 8;

const DEGENERATE_EXTENT = 1e-9;

// ---- Small helpers ----

function collectMeshes(model) {
  const meshes = [];
  model.traverse((obj) => {
    if (obj.isMesh && obj.geometry && obj.geometry.attributes && obj.geometry.attributes.position) meshes.push(obj);
  });
  return meshes;
}

function isSkinnedMesh(mesh) {
  return !!mesh.isSkinnedMesh || isSkinnedGeometry(mesh.geometry);
}

function sharedModel(model) {
  return { object: model, sharesFullModel: true };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function positionsAreFinite(geometry) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) return false;
  }
  return true;
}

// Repeats simplification passes on one geometry until it is at the target,
// stuck, or out of passes. Yields many times within every pass (#3483) so a
// caller can enforce a frame budget. Never modifies or disposes the input; returns either the
// input itself or a geometry this function created.
export function* simplifyToTarget(geometry, targetTriangles, options = {}) {
  let current = geometry;
  // #3528: a pass that opens new holes in the mesh is not kept. A shopper saw a
  // toilet "all jagged with holes" from a distance: the full model is closed, its
  // mid version had more than half its edges on a hole, because each pass is
  // allowed to tear a little and twelve passes compound it. So after every pass
  // the number of edges on a hole is counted; a pass that adds any is tried
  // again removing less, and if that tears too the result stops there: a
  // heavier simpler version with no holes beats a lighter one with them.
  let currentBoundary = yield* boundaryEdgeCountSteps(current);
  for (let pass = 0; pass < MAX_SIMPLIFY_PASSES; pass++) {
    const before = countTriangles(current);
    if (before <= targetTriangles) break;
    let next = null;
    let nextBoundary = 0;
    for (const fraction of PASS_REMOVAL_FRACTIONS) {
      const candidate = yield* simplifyGeometryOnePassSteps(current, targetTriangles, fraction, options);
      yield;
      if (!candidate) break;
      const count = yield* boundaryEdgeCountSteps(candidate);
      if (count <= currentBoundary + HOLE_TOLERANCE_EDGES) {
        next = candidate;
        nextBoundary = count;
        break;
      }
      candidate.dispose();
    }
    if (!next) break;
    const after = countTriangles(next);
    if (after < MIN_RESULT_TRIANGLES || !positionsAreFinite(next) || after >= before * MIN_PASS_PROGRESS) {
      next.dispose();
      break;
    }
    if (current !== geometry) current.dispose();
    current = next;
    currentBoundary = nextBoundary;
  }
  return current;
}

// ---- Texture pixels (injectable, canvas-free by default where possible) ----

// Default reader for a decoded browser image (HTMLImageElement, ImageBitmap,
// canvas). Returns null where no canvas exists (node, workers without
// OffscreenCanvas) or the image cannot be read (cross-origin, closed).
function readImagePixelsWithCanvas(image) {
  const width = image.width;
  const height = image.height;
  if (!(width > 0) || !(height > 0)) return null;
  let canvas = null;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  if (!canvas) return null;
  try {
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { data: imageData.data, width, height };
  } catch {
    return null;
  }
}

// #3521: a canvas holding RGBA8 pixels, or null where no canvas exists. The
// glTF exporter merges a separate metalness map and roughness map by drawing
// both into a canvas (`drawImage`), which a DataTexture's raw pixel array cannot
// be, so a downsized texture has to carry something drawable where the browser
// can make one.
function canvasImageFromPixels(data, width, height) {
  let canvas = null;
  if (typeof document !== 'undefined') canvas = document.createElement('canvas');
  else if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  if (!canvas) return null;
  try {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

// RGBA8 pixels of a texture, row 0 first, or null if unreadable. A
// DataTexture-style image ({data, width, height}) is read directly, with no
// canvas; anything else goes through readImagePixels.
export function readTexturePixels(texture, readImagePixels = readImagePixelsWithCanvas) {
  const image = texture && texture.image;
  if (!image) return null;
  const { width, height } = image;
  if (!(width > 0) || !(height > 0)) return null;
  if (image.data) {
    return image.data.length === width * height * 4 ? { data: image.data, width, height } : null;
  }
  return readImagePixels(image);
}

// Area-average (box filter) downsample of RGBA8 pixels to the given size.
//
// #3483: a generator that yields after about BOX_SLICE_SOURCE_PIXELS source
// pixels have been read, so one large texture is spread across frames instead of
// being a single task (a 4096 x 4096 texture is sixteen million pixels).
const BOX_SLICE_SOURCE_PIXELS = 1 << 18;
function* boxDownsample(pixels, newWidth, newHeight) {
  const { data, width, height } = pixels;
  const out = new Uint8Array(newWidth * newHeight * 4);
  let sincePause = 0;
  for (let y = 0; y < newHeight; y++) {
    const y0 = Math.floor((y * height) / newHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / newHeight));
    for (let x = 0; x < newWidth; x++) {
      const x0 = Math.floor((x * width) / newWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / newWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      const o = (y * newWidth + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
      sincePause += n;
    }
    if (sincePause >= BOX_SLICE_SOURCE_PIXELS) {
      sincePause = 0;
      yield;
    }
  }
  return out;
}

// A smaller copy of a texture, or the texture itself when it is already
// small enough or its pixels cannot be read.
function* downsizeTexture(texture, maxSize, getPixels, makeImage) {
  const pixels = getPixels(texture);
  yield; // #3483: reading a large image back is a task of its own
  if (!pixels) return texture;
  const longest = Math.max(pixels.width, pixels.height);
  if (longest <= maxSize) return texture;
  const scale = maxSize / longest;
  const newWidth = Math.max(1, Math.floor(pixels.width * scale));
  const newHeight = Math.max(1, Math.floor(pixels.height * scale));
  const data = yield* boxDownsample(pixels, newWidth, newHeight);
  // Drawable where a canvas exists (#3521), raw pixels otherwise (node, workers).
  const image = makeImage(data, newWidth, newHeight);
  const out = image ? new CanvasTexture(image) : new DataTexture(data, newWidth, newHeight, RGBAFormat, UnsignedByteType);
  out.name = texture.name;
  out.colorSpace = texture.colorSpace;
  out.wrapS = texture.wrapS;
  out.wrapT = texture.wrapT;
  out.flipY = texture.flipY;
  out.channel = texture.channel;
  out.offset.copy(texture.offset);
  out.repeat.copy(texture.repeat);
  out.center.copy(texture.center);
  out.rotation = texture.rotation;
  out.generateMipmaps = true;
  out.minFilter = LinearMipmapLinearFilter;
  out.magFilter = LinearFilter;
  out.needsUpdate = true;
  return out;
}

// A copy of the material with every over-sized texture replaced by a smaller
// one, or the material itself when nothing needed shrinking. Cached so
// meshes that share a material keep sharing it in the mid model.
function* downsizeMaterial(material, maxSize, getPixels, cache, makeImage) {
  if (!material) return material;
  if (cache.has(material)) return cache.get(material);
  let replaced = null;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (!value || !value.isTexture) continue;
    const smaller = yield* downsizeTexture(value, maxSize, getPixels, makeImage);
    if (smaller !== value) {
      if (!replaced) replaced = material.clone();
      replaced[key] = smaller;
    }
  }
  const result = replaced || material;
  cache.set(material, result);
  return result;
}

// ---- Mid ----

function* buildMid(model, meshes, options, getPixels, rung = 0) {
  const makeImage = options.makeImage ?? canvasImageFromPixels;
  const total = meshes.reduce((sum, mesh) => sum + countTriangles(mesh.geometry), 0);
  const fraction = MID_FRACTION_LADDER[rung] ?? MID_TRIANGLE_FRACTION;
  const target = clamp(Math.round(total * fraction), MID_MIN_TRIANGLES, MID_MAX_TRIANGLES * (rung + 1));

  const clone = model.clone(true);
  const cloneMeshes = collectMeshes(clone);
  const maxTextureSize = options.midTextureMaxSize ?? MID_TEXTURE_MAX_SIZE;
  const materialCache = new Map();
  let changed = false;

  for (let i = 0; i < cloneMeshes.length; i++) {
    const cloneMesh = cloneMeshes[i];
    const geometry = cloneMesh.geometry;
    const triangles = countTriangles(geometry);
    if (total > target) {
      const meshTarget = Math.max(MID_MIN_TRIANGLES_PER_MESH, Math.round((triangles * target) / total));
      if (triangles > meshTarget) {
        const simplified = yield* simplifyToTarget(geometry, meshTarget, { lockBorders: options.lockBorders ?? true });
        if (simplified !== geometry) {
          cloneMesh.geometry = simplified;
          changed = true;
        }
      }
    }
    const materials = Array.isArray(cloneMesh.material) ? cloneMesh.material : [cloneMesh.material];
    const resized = [];
    for (const material of materials) resized.push(yield* downsizeMaterial(material, maxTextureSize, getPixels, materialCache, makeImage));
    if (resized.some((material, index) => material !== materials[index])) {
      cloneMesh.material = Array.isArray(cloneMesh.material) ? resized : resized[0];
      changed = true;
    }
  }

  // Nothing to shrink: the full model is the mid model. No copy to hold.
  if (!changed) return sharedModel(model);
  return { object: clone, sharesFullModel: false };
}

// ---- Fidelity (#4062) ----

function triangleArea(p, at) {
  const ux = p[at + 3] - p[at], uy = p[at + 4] - p[at + 1], uz = p[at + 5] - p[at + 2];
  const vx = p[at + 6] - p[at], vy = p[at + 7] - p[at + 1], vz = p[at + 8] - p[at + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

// #4111: the mean colour a mesh shows when lit: material colour x mean vertex colour x mean texture
// colour, scaled and lit as the far bake does (shadingOf), linear RGB. The far version's own vertex colours
// already hold all of that and its material is plain white, so the same product reads right for both.
function litColorOf(mesh, getPixels) {
  const material = materialForMesh(mesh);
  const base = material && material.color ? material.color.clone() : new Color(FALLBACK_BASE_COLOR);
  const vertexColor = mesh.geometry.attributes.color;
  if (vertexColor && (!material || material.vertexColors)) {
    // Area-weighted, as the silhouette is: a mesh with many small triangles in one colour must not outweigh
    // a large flat one.
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const pa = new Vector3(), pb = new Vector3(), pc = new Vector3();
    let total = 0, r = 0, g = 0, b = 0;
    for (let t = 0; t + 2 < count; t += 3) {
      const ia = index ? index.getX(t) : t, ib = index ? index.getX(t + 1) : t + 1, ic = index ? index.getX(t + 2) : t + 2;
      pa.fromBufferAttribute(position, ia); pb.fromBufferAttribute(position, ib); pc.fromBufferAttribute(position, ic);
      const area = pb.sub(pa).cross(pc.sub(pa)).length() * 0.5;
      total += area;
      r += area * (vertexColor.getX(ia) + vertexColor.getX(ib) + vertexColor.getX(ic)) / 3;
      g += area * (vertexColor.getY(ia) + vertexColor.getY(ib) + vertexColor.getY(ic)) / 3;
      b += area * (vertexColor.getZ(ia) + vertexColor.getZ(ib) + vertexColor.getZ(ic)) / 3;
    }
    if (total > 0) { base.r *= r / total; base.g *= g / total; base.b *= b / total; }
  }
  const map = material && material.map ? material.map : null;
  const pixels = map && getPixels ? getPixels(map) : null;
  // A texture whose pixels cannot be read gives no colour to compare, not a wrong one.
  if (map && !pixels) return null;
  if (pixels) {
    const mean = meanTextureColor(map, pixels);
    base.r *= mean.r; base.g *= mean.g; base.b *= mean.b;
  }
  const { diffuseScale, emissive } = shadingOf(material);
  return [base.r * diffuseScale + emissive.r, base.g * diffuseScale + emissive.g, base.b * diffuseScale + emissive.b];
}

// The triangles of `object`'s visible meshes in the object's own root space, as the flat batches
// src/tierFidelity.js compares. A mesh whose material is single-sided shows only its front faces.
export function fidelityBatches(object, getPixels = null) {
  object.updateWorldMatrix(true, true);
  const rootInverse = object.matrixWorld.clone().invert();
  const matrix = new Matrix4();
  const point = new Vector3();
  const batches = [];
  for (const mesh of collectMeshes(object)) {
    if (mesh.visible === false) continue;
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    matrix.multiplyMatrices(rootInverse, mesh.matrixWorld);
    const mirrored = matrix.determinant() < 0;
    const positions = new Float32Array(Math.floor(count / 3) * 9);
    let area = 0;
    for (let t = 0; t + 2 < count; t += 3) {
      for (let k = 0; k < 3; k++) {
        // A mirrored transform flips the winding; undo it so "front" is what the viewer sees.
        const corner = mirrored && k > 0 ? 3 - k : k;
        const vertex = index ? index.getX(t + corner) : t + corner;
        point.fromBufferAttribute(position, vertex).applyMatrix4(matrix);
        const at = (t / 3) * 9 + k * 3;
        positions[at] = point.x;
        positions[at + 1] = point.y;
        positions[at + 2] = point.z;
      }
      area += triangleArea(positions, (t / 3) * 9);
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    batches.push({
      positions,
      doubleSided: materials.some((material) => material && material.side === DoubleSide),
      area,
      color: litColorOf(mesh, getPixels), // #4111: what this mesh looks like lit, to check a version's colour
    });
  }
  return batches;
}

function tierIsFaithful(fullBatches, object, tier, getPixels = null) {
  return isFaithful(silhouetteFidelity(fullBatches, fidelityBatches(object, getPixels)), tier);
}

// A far version made of the model's own outline: the convex hull of its extreme points in 26 directions
// (about fifty triangles), coloured from the model's own baked colours at those points. It covers
// everything the model covers from any side, which is the thing a far version must do; it is used only
// when the ordinary simplified far version failed the check, so a model that simplifies well never gets it.
function buildHullFar(parts) {
  const extremes = new Map();
  for (const direction of HULL_DIRECTIONS) {
    let best = null;
    let bestValue = -Infinity;
    const probe = new Vector3();
    for (const part of parts) {
      const position = part.geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        probe.fromBufferAttribute(position, i);
        const value = probe.dot(direction);
        if (value > bestValue) {
          bestValue = value;
          best = { part, i };
        }
      }
    }
    if (best) extremes.set(`${parts.indexOf(best.part)}:${best.i}`, best);
  }
  const points = [];
  const colorOf = new Map();
  for (const { part, i } of extremes.values()) {
    const position = part.geometry.attributes.position;
    const color = part.geometry.attributes.color;
    const vertex = new Vector3().fromBufferAttribute(position, i);
    points.push(vertex);
    colorOf.set(vertex, color ? new Color(color.getX(i), color.getY(i), color.getZ(i)) : new Color(FALLBACK_BASE_COLOR));
  }
  if (points.length < 4) return null;
  let hull;
  try {
    hull = new ConvexHull().setFromPoints(points);
  } catch (_) {
    return null;
  }
  const positions = [];
  const colors = [];
  const nearestColor = (target) => {
    let best = null;
    let bestDistance = Infinity;
    for (const vertex of points) {
      const distance = vertex.distanceToSquared(target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
    return colorOf.get(best);
  };
  for (const face of hull.faces) {
    const corners = [];
    let edge = face.edge;
    do {
      corners.push(edge.head().point);
      edge = edge.next;
    } while (edge !== face.edge);
    for (let i = 1; i + 1 < corners.length; i++) {
      for (const corner of [corners[0], corners[i], corners[i + 1]]) {
        positions.push(corner.x, corner.y, corner.z);
        const color = nearestColor(corner);
        colors.push(color.r, color.g, color.b);
      }
    }
  }
  if (positions.length < 9) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// #4111: a model of unlit materials (KHR_materials_unlit loads as MeshBasicMaterial) is drawn without
// light, so its far version is too: a lit far version shaded a model that has no shading anywhere else.
function farObject(geometry, unlit = false) {
  const material = unlit
    ? new MeshBasicMaterial({ vertexColors: true, side: DoubleSide })
    : new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'far';
  const group = new Group();
  group.name = 'farTier';
  group.add(mesh);
  return { object: group, sharesFullModel: false };
}

// ---- Far ----

function materialForMesh(mesh) {
  const material = mesh.material;
  if (!Array.isArray(material)) return material;
  // A multi-material mesh (FBX imports): use the material that covers the
  // most triangles. glTF models arrive as one material per mesh.
  const geometry = mesh.geometry;
  if (!geometry.groups || geometry.groups.length === 0) return material[0];
  let best = geometry.groups[0];
  for (const group of geometry.groups) if (group.count > best.count) best = group;
  return material[best.materialIndex] || material[0];
}

function toLinear(texture, r, g, b, target) {
  if (texture.colorSpace === SRGBColorSpace) return target.setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
  return target.setRGB(r / 255, g / 255, b / 255);
}

function meanTextureColor(texture, pixels) {
  const sum = new Color(0, 0, 0);
  const tmp = new Color();
  const { data, width, height } = pixels;
  for (let gy = 0; gy < TEXTURE_MEAN_GRID; gy++) {
    const y = Math.min(height - 1, Math.floor(((gy + 0.5) * height) / TEXTURE_MEAN_GRID));
    for (let gx = 0; gx < TEXTURE_MEAN_GRID; gx++) {
      const x = Math.min(width - 1, Math.floor(((gx + 0.5) * width) / TEXTURE_MEAN_GRID));
      const i = (y * width + x) * 4;
      toLinear(texture, data[i], data[i + 1], data[i + 2], tmp);
      sum.r += tmp.r;
      sum.g += tmp.g;
      sum.b += tmp.b;
    }
  }
  const n = TEXTURE_MEAN_GRID * TEXTURE_MEAN_GRID;
  return sum.setRGB(sum.r / n, sum.g / n, sum.b / n);
}

function wrapCoordinate(value, wrap) {
  if (wrap === ClampToEdgeWrapping) return clamp(value, 0, 1);
  return value - Math.floor(value);
}

function sampleTexture(texture, pixels, u, v, target) {
  const { data, width, height } = pixels;
  const wu = wrapCoordinate(u, texture.wrapS);
  const wv = wrapCoordinate(texture.flipY ? 1 - v : v, texture.wrapT);
  const x = Math.min(width - 1, Math.floor(wu * width));
  const y = Math.min(height - 1, Math.floor(wv * height));
  const i = (y * width + x) * 4;
  return toLinear(texture, data[i], data[i + 1], data[i + 2], target);
}

// #4111: the far colour is what the full model looks like lit, not its raw base colour. This world has
// no environment light, so a metal surface is drawn from its sun and sky light only, much darker than
// its base colour, while the far material (metalness 0) drew that same base colour at full strength: a
// metal fixture turned white at mid distance. A metal keeps a floor of its colour for the highlights a
// flat far surface cannot show. A metalness map is not read (a scalar of 1 beside a map says nothing
// about where the metal is). Emission is added, since the far material is not emissive.
const FAR_METAL_DARKENING = 0.65;
function shadingOf(material) {
  const metalness = material && !material.metalnessMap && typeof material.metalness === 'number' ? clamp(material.metalness, 0, 1) : 0;
  const emissive = material && material.emissive && !material.emissiveMap
    ? material.emissive.clone().multiplyScalar(material.emissiveIntensity ?? 1)
    : new Color(0, 0, 0);
  return { diffuseScale: 1 - FAR_METAL_DARKENING * metalness, emissive };
}

// A copy of the geometry carrying only position (and index) plus a baked
// linear-colour attribute: material colour x texture x existing vertex colour.
function bakeColoredGeometry(mesh, getPixels) {
  const source = mesh.geometry;
  const position = source.attributes.position;
  const count = position.count;
  const material = materialForMesh(mesh);

  const base = material && material.color ? material.color.clone() : new Color(FALLBACK_BASE_COLOR);
  // #4111: a colour attribute is drawn only when the material asks for it; baking it in regardless made
  // far versions a different colour from the model they stand for.
  const vertexColor = !material || material.vertexColors ? source.attributes.color : null;
  const uv = source.attributes.uv;
  const map = material && material.map ? material.map : null;
  const pixels = map ? getPixels(map) : null;
  const sampled = !!(pixels && uv && count >= TEXTURE_SAMPLE_MIN_VERTICES);
  const mean = pixels && !sampled ? meanTextureColor(map, pixels) : null;
  const { diffuseScale, emissive } = shadingOf(material);

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const tmp = new Color();
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
    let r = base.r;
    let g = base.g;
    let b = base.b;
    if (vertexColor) {
      r *= vertexColor.getX(i);
      g *= vertexColor.getY(i);
      b *= vertexColor.getZ(i);
    }
    if (sampled) {
      sampleTexture(map, pixels, uv.getX(i), uv.getY(i), tmp);
      r *= tmp.r;
      g *= tmp.g;
      b *= tmp.b;
    } else if (mean) {
      r *= mean.r;
      g *= mean.g;
      b *= mean.b;
    }
    colors[i * 3] = r * diffuseScale + emissive.r;
    colors[i * 3 + 1] = g * diffuseScale + emissive.g;
    colors[i * 3 + 2] = b * diffuseScale + emissive.b;
  }

  const baked = new BufferGeometry();
  baked.setAttribute('position', new Float32BufferAttribute(positions, 3));
  baked.setAttribute('color', new Float32BufferAttribute(colors, 3));
  if (source.index) {
    const indexArray = source.index.array;
    baked.setIndex(Array.from(indexArray));
  }
  return baked;
}

// The simplifier may carry extra attributes through; mergeGeometries needs
// every part to have exactly the same set, so keep only what the far model uses.
function positionAndColorOnly(geometry) {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'color') geometry.deleteAttribute(name);
  }
  return geometry;
}

function boxVolume(box) {
  const size = box.getSize(new Vector3());
  return size.x * size.y * size.z;
}

// Maps the far geometry's bounding box onto the full model's, axis by axis,
// but only when it has drifted past FAR_BBOX_TOLERANCE of the diagonal.
function fitBoundingBox(geometry, targetBox) {
  geometry.computeBoundingBox();
  const farBox = geometry.boundingBox;
  const diagonal = targetBox.getSize(new Vector3()).length();
  if (!(diagonal > DEGENERATE_EXTENT)) return;
  const tolerance = diagonal * FAR_BBOX_TOLERANCE;
  const drifted =
    Math.abs(farBox.min.x - targetBox.min.x) > tolerance || Math.abs(farBox.max.x - targetBox.max.x) > tolerance
    || Math.abs(farBox.min.y - targetBox.min.y) > tolerance || Math.abs(farBox.max.y - targetBox.max.y) > tolerance
    || Math.abs(farBox.min.z - targetBox.min.z) > tolerance || Math.abs(farBox.max.z - targetBox.max.z) > tolerance;
  if (!drifted) return;

  const farSize = farBox.getSize(new Vector3());
  const targetSize = targetBox.getSize(new Vector3());
  const scale = new Vector3(1, 1, 1);
  for (const axis of ['x', 'y', 'z']) {
    // A flat axis (a plane) has nothing to scale; it is only translated.
    if (farSize[axis] > DEGENERATE_EXTENT && targetSize[axis] > DEGENERATE_EXTENT) scale[axis] = targetSize[axis] / farSize[axis];
  }
  const matrix = new Matrix4()
    .makeTranslation(targetBox.min.x, targetBox.min.y, targetBox.min.z)
    .multiply(new Matrix4().makeScale(scale.x, scale.y, scale.z))
    .multiply(new Matrix4().makeTranslation(-farBox.min.x, -farBox.min.y, -farBox.min.z));
  geometry.applyMatrix4(matrix);
}

function* buildFar(model, meshes, getPixels, fullBatches) {
  const visible = meshes.filter((mesh) => mesh.visible !== false);
  if (visible.length === 0) return sharedModel(model);

  model.updateWorldMatrix(true, true);
  const rootInverse = model.matrixWorld.clone().invert();

  // Everything in the root's own space, with colour baked in.
  const parts = [];
  const fullBox = new Box3();
  for (const mesh of visible) {
    const baked = bakeColoredGeometry(mesh, getPixels);
    baked.applyMatrix4(new Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld));
    baked.computeBoundingBox();
    fullBox.union(baked.boundingBox);
    parts.push({ geometry: baked, triangles: countTriangles(baked), volume: boxVolume(baked.boundingBox) });
  }
  const total = parts.reduce((sum, part) => sum + part.triangles, 0);
  if (total === 0) return sharedModel(model);

  // A model already within budget keeps its own geometry (merged, coloured).
  const target = total <= FAR_MAX_TRIANGLES ? total : clamp(Math.round(total * FAR_TRIANGLE_FRACTION), FAR_MIN_TRIANGLES, FAR_MAX_TRIANGLES);

  // Too many parts to give each its minimum: keep the biggest ones.
  let kept = parts;
  if (total > target && parts.length * FAR_MIN_TRIANGLES_PER_MESH > target) {
    const limit = Math.max(1, Math.floor(target / FAR_MIN_TRIANGLES_PER_MESH));
    kept = parts
      .map((part, index) => ({ part, index }))
      .sort((a, b) => b.part.volume - a.part.volume || a.index - b.index)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.part);
  }
  const keptTotal = kept.reduce((sum, part) => sum + part.triangles, 0);

  const simplifiedParts = [];
  for (const part of kept) {
    let geometry = part.geometry;
    if (total > target) {
      const partTarget = Math.max(FAR_MIN_TRIANGLES_PER_MESH, Math.round((target * part.triangles) / keptTotal));
      geometry = yield* simplifyToTarget(part.geometry, partTarget);
    }
    simplifiedParts.push(positionAndColorOnly(geometry.index ? geometry.toNonIndexed() : geometry));
  }

  const merged = mergeGeometries(simplifiedParts, false);
  if (!merged || countTriangles(merged) === 0) return sharedModel(model);
  merged.computeVertexNormals();
  fitBoundingBox(merged, fullBox);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  // #4062: a far version must still read as the model from every side. Single-sided drawing hid whatever
  // the simplifier left facing the wrong way, so the far material draws both sides; and a version that
  // still fails (a noisy open scan simplified to fifty triangles covered 0 to 36% of itself) is replaced
  // by the model's own outline. null means not even that held: the caller uses a more detailed version.
  const unlit = visible.every((mesh) => {
    const material = materialForMesh(mesh);
    return !!(material && material.isMeshBasicMaterial);
  });
  const simplified = farObject(merged, unlit);
  if (tierIsFaithful(fullBatches, simplified.object, 'far', getPixels)) return simplified;
  const hull = buildHullFar(parts);
  if (hull) {
    const outline = farObject(hull, unlit);
    if (tierIsFaithful(fullBatches, outline.object, 'far', getPixels)) return outline;
  }
  return null;
}

// ---- Public API ----

function triangleCountOf(object) {
  let total = 0;
  for (const mesh of collectMeshes(object)) total += countTriangles(mesh.geometry);
  return total;
}

// The chunkable form: yields after every simplification pass and returns
// { mid, far, stats } when done. mid and far are { object, sharesFullModel }:
// when sharesFullModel is true the object is the input model itself (nothing
// to shrink, or a skinned model left alone), so do not dispose it twice.
//
// options.readImagePixels(image) -> { data, width, height } | null reads a
// decoded image's RGBA8 pixels (the default uses a canvas where one exists);
// options.makeImage(data, width, height) -> a drawable image or null makes the
// image a downsized texture carries (the default is a canvas where one exists);
// options.midTextureMaxSize overrides MID_TEXTURE_MAX_SIZE.
export function* modelTierSteps(model, options = {}) {
  const meshes = collectMeshes(model);
  const full = meshes.reduce((sum, mesh) => sum + countTriangles(mesh.geometry), 0);

  if (meshes.length === 0 || full === 0 || meshes.some(isSkinnedMesh)) {
    return { mid: sharedModel(model), far: sharedModel(model), stats: { full, mid: full, far: full } };
  }

  const pixelCache = new Map();
  const getPixels = (texture) => {
    if (!pixelCache.has(texture)) pixelCache.set(texture, readTexturePixels(texture, options.readImagePixels));
    return pixelCache.get(texture);
  };

  // #4062: every simpler version is checked against the full model (src/tierFidelity.js). A mid version
  // that fails is retried gentler (MID_FRACTION_LADDER) and ends at the model's own geometry; a far version
  // that fails falls back to the model's outline, then to the mid version.
  const fullBatches = fidelityBatches(model, getPixels);
  let mid = null;
  for (let rung = 0; rung < MID_FRACTION_LADDER.length && !mid; rung++) {
    const candidate = yield* buildMid(model, meshes, options, getPixels, rung);
    if (candidate.sharesFullModel || tierIsFaithful(fullBatches, candidate.object, 'mid', getPixels)) mid = candidate;
  }
  if (!mid) mid = sharedModel(model);
  let far = yield* buildFar(model, meshes, getPixels, fullBatches);
  if (!far) far = mid.sharesFullModel ? sharedModel(model) : { object: mid.object.clone(true), sharesFullModel: false };
  return { mid, far, stats: { full, mid: triangleCountOf(mid.object), far: triangleCountOf(far.object) } };
}

// Runs the whole job at once.
export function buildModelTiersSync(model, options = {}) {
  const job = modelTierSteps(model, options);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

// Runs the job in slices of at most about frameBudgetMs, awaiting nextFrame()
// between slices so a caller can keep rendering (#3396). nextFrame defaults
// to a macrotask; a browser caller passes requestAnimationFrame.
export async function buildModelTiers(model, options = {}) {
  const frameBudgetMs = options.frameBudgetMs ?? DEFAULT_FRAME_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const nextFrame = options.nextFrame ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
  const job = modelTierSteps(model, options);
  let sliceStart = now();
  let step = job.next();
  while (!step.done) {
    if (now() - sliceStart >= frameBudgetMs) {
      await nextFrame();
      sliceStart = now();
    }
    step = job.next();
  }
  return step.value;
}
