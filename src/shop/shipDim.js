// #4602 (Shipping 5/8, part of #4394): the draw-time dim for a physical product that does not ship to the shopper.
// "Everything built is always shown as itself": the real model is drawn, never a stand-in, never hidden; a dimmed one
// is washed toward the brand's pale cream by a fragment-shader mix, driven by one uniform per product (its template).
//
// The materials are patched where a placement's materials are made (instantiateScene in src/world/models.js), so the
// patch is on every material the shop draws a product with: loose placements, the instanced batches and their mid and
// far sets, and the far view. The other effects that swap a mesh's materials for clones (the arrival dissolve, the tier
// cross-fade) chain the `onBeforeCompile` and program key they find, so they keep the dim. Turning the switch on or off
// changes one number per product (setShipDim), not a material: nothing is recompiled and no frame is skipped.
//
// Imports only three.js (and nothing from the browser), so it runs in the unit-test pool.

export const SHIP_DIM_UNIFORM_NAME = 'uShipDim';
// The wash: how far a dimmed product moves toward the colour, and the colour (the brand cream, app.css).
export const SHIP_DIM_STRENGTH = 0.62;
const SHIP_DIM_COLOR = 'vec3(0.965, 0.945, 0.871)';

const uniforms = new Map(); // template id -> { value } shared by every material drawn for that product

export function shipDimUniform(key) {
  let uniform = uniforms.get(key);
  if (!uniform) {
    uniform = { value: 0 };
    uniforms.set(key, uniform);
  }
  return uniform;
}

// Patches a fragment shader; false (nothing changed) for a material without the marker, which stays undimmed.
export function patchShipDimShader(shader, uniform) {
  const source = shader.fragmentShader;
  if (!source.includes('#include <common>') || !source.includes('#include <dithering_fragment>')) return false;
  shader.uniforms[SHIP_DIM_UNIFORM_NAME] = uniform;
  shader.fragmentShader = source
    .replace('#include <common>', `#include <common>\nuniform float ${SHIP_DIM_UNIFORM_NAME};`)
    .replace('#include <dithering_fragment>',
      `#include <dithering_fragment>\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, ${SHIP_DIM_COLOR}, ${SHIP_DIM_UNIFORM_NAME} * ${SHIP_DIM_STRENGTH.toFixed(2)});`);
  return true;
}

function patchMaterial(material, uniform) {
  if (!material || material.userData?.shipDim) return;
  material.userData.shipDim = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    patchShipDimShader(shader, uniform);
  };
  const baseKey = material.customProgramCacheKey ? material.customProgramCacheKey() : '';
  material.customProgramCacheKey = () => `${baseKey}|ship-dim`;
  material.needsUpdate = true;
}

// Makes every material under `root` (a freshly cloned model, so the materials are its own) carry the dim of `key`.
export function applyShipDim(root, key) {
  const uniform = shipDimUniform(key);
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    if (Array.isArray(child.material)) child.material.forEach((material) => patchMaterial(material, uniform));
    else patchMaterial(child.material, uniform);
  });
}

// `levels`: [{ key, dim }] for every physical product the shop knows. One number each.
export function setShipDim(levels) {
  for (const { key, dim } of levels) shipDimUniform(key).value = dim ? 1 : 0;
}

// For the e2e: what the page holds for each product.
export function shipDimLevels() {
  return Object.fromEntries([...uniforms].map(([key, uniform]) => [key, uniform.value]));
}
