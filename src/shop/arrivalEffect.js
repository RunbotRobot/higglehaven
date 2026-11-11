// #3406 (leaf 2/3 of #3397, "Things arrive in the world through fog; nothing
// pops in"): the two visual pieces of an arrival, with no knowledge of when to
// run them. Leaf 1 (#3405) decides the timeline and hands this module plain
// levels (0 to 1); leaf 3 (#3407) wires both into the Shop loader.
//
// - createArrivalFog: a patch of soft fog (a few sprite billboards sharing one
//   material and one texture) over a cluster's known extent.
// - createArrivalDissolve: makes a model's materials dissolve in through a
//   dither, driven by one uniform. The materials are never switched to
//   `transparent` (hundreds of them would cost sorting and overdraw); a
//   fragment is either kept or discarded by a screen-space noise threshold.
//
// Both own what they create and release all of it in dispose()/restore(), so an
// unload or a superseded load leaves nothing behind.
import * as THREE from 'three';

// Brand palette (the sky and creams from app.css), soft and light.
export const ARRIVAL_FOG_COLOR = 0xf6f1de;
// Peak opacity of a single puff; overlapping puffs build the body of the fog.
export const ARRIVAL_FOG_PEAK_OPACITY = 0.55;
const FOG_TEXTURE_SIZE = 32;
const MIN_PUFFS = 3;
const MAX_PUFFS = 10;

// How many puffs a cluster of the given extent gets: more for a wide wall, but
// bounded so one huge cluster stays cheap. A pure function of the extent.
export function arrivalFogPuffCount({ width, depth }) {
  const footprint = Math.sqrt(Math.max(width, 0) * Math.max(depth, 0));
  return Math.min(MAX_PUFFS, Math.max(MIN_PUFFS, Math.round(footprint / 2)));
}

// Deterministic 0..1 from an integer, so a cluster's fog looks the same every
// time it arrives (and tests are stable).
function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// A soft round falloff, white with the alpha going smoothly to zero at the
// rim. A DataTexture so it needs no canvas or DOM.
function createSoftDiscTexture() {
  const size = FOG_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const falloff = (1 - r) * (1 - r) * (3 - 2 * (1 - r)); // smooth, 0 at the rim
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * falloff);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// A fog over `center` (the cluster's centre, in `parent`'s space) with the
// cluster's `extent` ({ width, depth, height } in metres). Add `object` to the
// scene, call setLevel(0..1) each frame, then dispose().
export function createArrivalFog({ center, extent, seed = 0 }) {
  const texture = createSoftDiscTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: ARRIVAL_FOG_COLOR,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const object = new THREE.Group();
  object.name = 'arrival-fog';
  object.position.set(center.x, center.y, center.z);

  const count = arrivalFogPuffCount(extent);
  const puffDiameter = Math.max(1.5, Math.max(extent.width, extent.depth, extent.height) * 0.6);
  const sprites = [];
  for (let i = 0; i < count; i += 1) {
    const sprite = new THREE.Sprite(material);
    // Spread over the footprint, at heights across the item.
    sprite.position.set(
      (hash01(seed * 31 + i * 3 + 1) - 0.5) * extent.width,
      (hash01(seed * 31 + i * 3 + 2) - 0.5) * extent.depth,
      (hash01(seed * 31 + i * 3 + 3) - 0.2) * extent.height,
    );
    const scale = puffDiameter * (0.7 + 0.6 * hash01(seed * 17 + i));
    sprite.scale.set(scale, scale, 1);
    sprite.renderOrder = 5; // after the opaque world, never writing depth
    sprites.push(sprite);
    object.add(sprite);
  }

  let disposed = false;
  return {
    object,
    puffCount: count,
    // level 0 = no fog, 1 = full fog.
    setLevel(level) {
      if (disposed) return;
      const clamped = Math.min(1, Math.max(0, level));
      material.opacity = ARRIVAL_FOG_PEAK_OPACITY * clamped;
      object.visible = clamped > 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      for (const sprite of sprites) sprite.removeFromParent();
      sprites.length = 0;
      material.dispose();
      texture.dispose();
    },
  };
}

// The dissolve: interleaved gradient noise from the fragment's screen position,
// kept where the noise is below the level. Level 1 keeps every fragment.
// #3494: the uniform's name is a parameter so a second dissolve (the tier
// cross-fade) can sit on a material the arrival dissolve already patched
// without redeclaring the same uniform.
export const ARRIVAL_UNIFORM_NAME = 'uArrivalLevel';
const dissolveUniformDeclaration = (name) => `uniform float ${name};`;
const dissolveDiscard = (name) => `
  if (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) >= ${name}) discard;
`;

// Patches a shader's fragment source. Returns false (and changes nothing) for a
// material whose shader lacks the markers, which then simply stays opaque.
export function patchDissolveShader(shader, uniform, name = ARRIVAL_UNIFORM_NAME) {
  const source = shader.fragmentShader;
  if (!source.includes('#include <common>') || !source.includes('#include <clipping_planes_fragment>')) {
    return false;
  }
  shader.uniforms[name] = uniform;
  shader.fragmentShader = source
    .replace('#include <common>', `#include <common>\n${dissolveUniformDeclaration(name)}`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${dissolveDiscard(name)}`);
  return true;
}

// Makes every mesh under `root` dissolve in. Each distinct original material is
// replaced by one clone carrying the patched shader (originals are shared with
// the cached model and are never modified); restore() puts the originals back
// and disposes the clones. setLevel(0..1): 0 shows nothing, 1 the whole item.
export function createArrivalDissolve(root, { uniformName = ARRIVAL_UNIFORM_NAME } = {}) {
  const uniform = { value: 0 };
  const clones = new Map(); // original material -> clone
  const swaps = []; // { mesh, original }

  function dissolvingMaterial(original) {
    let clone = clones.get(original);
    if (!clone) {
      clone = original.clone();
      const previous = original.onBeforeCompile;
      clone.onBeforeCompile = (shader, renderer) => {
        previous?.call(clone, shader, renderer);
        patchDissolveShader(shader, uniform, uniformName);
      };
      // One program for every clone of the same material type, and none shared
      // with the unpatched one.
      const baseKey = original.customProgramCacheKey ? original.customProgramCacheKey() : '';
      clone.customProgramCacheKey = () => `${baseKey}|arrival-dissolve|${uniformName}`;
      clone.needsUpdate = true;
      clones.set(original, clone);
    }
    return clone;
  }

  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const original = child.material;
    if (Array.isArray(original)) {
      swaps.push({ mesh: child, original });
      child.material = original.map(dissolvingMaterial);
    } else {
      swaps.push({ mesh: child, original });
      child.material = dissolvingMaterial(original);
    }
  });

  let restored = false;
  return {
    materialCount: clones.size,
    setLevel(level) {
      uniform.value = Math.min(1, Math.max(0, level));
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const { mesh, original } of swaps) mesh.material = original;
      swaps.length = 0;
      for (const clone of clones.values()) clone.dispose();
      clones.clear();
    },
  };
}
