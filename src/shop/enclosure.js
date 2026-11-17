// #3502 (part of #3418; owner decision "A place outside the world still looks
// like the world"): the world's own enclosure -- the standard grass disc, the
// hazy wall and the dome with its drifting sky -- as one function, so every
// place a person walks around mounts the same thing ("One model, not a
// hybrid"). Shop mounts it around the real world (enterShopMode); Sell mounts
// it around the showroom page (src/sell/worldView.js).
//
// This was three meshes built inline in enterShopMode. They moved here
// untouched: the matching 64-segment counts, the dome's polygon offset and the
// shared sky uniforms are the seam fixes from #166, #203, #1631 and
// owner-report-2026-10-20/21, and they live in the comments below.
//
// Shop and Sell are never active in the same page load, so the one shared sky
// material in sky.js (and the one dome rise it owns) is fine; each call
// re-initialises both.
import * as THREE from 'three';
import { createGroundTexture } from '../world/models.js';
import { curvatureDropM, relativeCurvatureDropM } from '../../worker/earthCurvature.js';
import { SHOP_WALL_HEIGHT_M } from '../main.js';
import {
  shopDomeRiseM, resetShopDomeRiseM, paintVerticalGradient,
  SHOP_SKY_VERTEX_SHADER, SHOP_SKY_FRAGMENT_SHADER, initShopSkyMaterial,
} from './sky.js';

// small ground/wall seam overlap only -- see the ground disc below
const SHOP_WALL_MARGIN_M = 1.5;
// A dome caps the wall's open top, and both share one continuous vertical
// gradient (pale ground-green at the base, through a hazy horizon blend
// right at the wall/dome seam, up to a deeper sky blue at the dome's own
// apex) painted directly as vertex colors rather than a texture -- see
// paintVerticalGradient. The illusion this is going for is a horizon that
// recedes into atmospheric haze and open sky, not a wall the world
// visibly stops at.
const SHOP_GROUND_HORIZON_COLOR = new THREE.Color(0xa8d98a); // the wall's own former flat color, now just its base
const SHOP_HAZY_HORIZON_COLOR = new THREE.Color(0xcfe8dc); // where wall meets dome -- both gradients hit this exact color, so the seam is invisible
const SHOP_SKY_DOME_COLOR = new THREE.Color(0x5a9fd4); // deeper than the flat backdrop sky (0x87ceeb) for a sense of real overhead depth

// #135 (docs/SPEC.md §1's "Earth-curvature coordinate system from day
// one"): a flat CircleGeometry's vertices lie exactly in its own XY plane
// (z = 0 everywhere) -- this nudges each one to where it actually sits on a
// curved Earth, relative to (worldCenterX, worldCenterY): the mesh's own
// local origin. Used only for a mesh that spans every distance from the
// origin out to the wall, where sagging visibly toward the rim over real
// world-radius distances is exactly the effect wanted, and there is no
// neighboring mesh it needs to blend with at a shared edge. (Per-landlet
// ground curvature isn't done this way -- see #135/#166 -- a landlet's own
// polygon is small enough that positioning/orienting its whole THREE.Group
// is both simpler and visually indistinguishable from a true per-vertex
// curve.) Called once right after building a ground mesh's geometry, before
// it's ever added to the scene.
export function applyGroundCurvature(geometry, worldCenterX, worldCenterY) {
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const localX = position.getX(i);
    const localY = position.getY(i);
    const drop = relativeCurvatureDropM(worldCenterX + localX, worldCenterY + localY, worldCenterX, worldCenterY);
    position.setZ(i, position.getZ(i) + drop);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

// Builds the ground disc, the wall and the dome for a world of `radiusM`,
// centred on the scene origin. Nothing is added to the scene here: the caller
// adds `objects` (and keeps them to dispose them), and hands `dome` to
// main.js's setShopDomeMesh so growShopDomeToHeight can raise it later.
//
// `groundUvScaleM`: null keeps CircleGeometry's own UVs (the texture tiles
// `repeat` times across the whole disc, which is what Shop has always drawn
// for the empty ground beyond any landlet). A number puts the UVs in
// "one unit per groundUvScaleM metres", the way normalizeGroundShapeUVs does
// for a landlet's own ground, so a disc under a landlet-sized page has the
// same grass density as the page and no visible edge between them (Sell).
export function createWorldEnclosure({ radiusM, groundUvScaleM = null }) {
  // The visible world stops at the wall -- no glimpse of "wild ground" that
  // isn't actually any land's own polygon. A thin overlap keeps the ground
  // from leaving a seam right at the wall's own base. Textured (#220) with
  // the same base brand green the flat fill used before (index.html's
  // --brand-green) -- this used to be a much darker forest green that read
  // as a heavy, ominous swath across an otherwise bright scene once every
  // visible landlet resolves against it; the mottling stays subtle for the
  // same reason.
  const groundGeometry = new THREE.CircleGeometry(radiusM + SHOP_WALL_MARGIN_M, 64);
  applyGroundCurvature(groundGeometry, 0, 0); // this mesh's own local origin *is* the world origin
  if (groundUvScaleM) {
    const uv = groundGeometry.attributes.uv;
    const position = groundGeometry.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, position.getX(i) / groundUvScaleM, position.getY(i) / groundUvScaleM);
    }
    uv.needsUpdate = true;
  }
  const ground = new THREE.Mesh(
    groundGeometry,
    new THREE.MeshStandardMaterial({ map: createGroundTexture() }),
  );

  // The wall's own ring sits at (essentially) one fixed distance from the
  // origin all the way around, so -- unlike the ground disc's per-vertex
  // applyGroundCurvature above, needed because that mesh spans every
  // distance from 0 out to the radius -- a single z offset lines its
  // base up with the already-curved ground it should be resting on instead
  // of the flat z=0 plane (#166, #203). Shared by the dome below, whose own
  // base sits on top of the wall's rim.
  const wallGroundDropM = curvatureDropM(radiusM);
  const wallGeometry = new THREE.CylinderGeometry(radiusM, radiusM, SHOP_WALL_HEIGHT_M, 64, 1, true);
  paintVerticalGradient(wallGeometry, (localY, out) => {
    const t = THREE.MathUtils.clamp((localY + SHOP_WALL_HEIGHT_M / 2) / SHOP_WALL_HEIGHT_M, 0, 1);
    out.copy(SHOP_GROUND_HORIZON_COLOR).lerp(SHOP_HAZY_HORIZON_COLOR, t);
  });
  // A custom shader (unlit, like the MeshBasicMaterial this replaced) so a
  // soft swirling cloud layer can be painted over the vertex-color gradient
  // below -- see createShopSkyMaterial's own comment. Shared with the dome
  // (created just below) so both animate in perfect sync off one clock.
  const skyMaterial = initShopSkyMaterial(radiusM);
  const wall = new THREE.Mesh(wallGeometry, skyMaterial);
  wall.rotation.x = Math.PI / 2; // THREE's cylinder stands along local Y by default -- this world is Z-up
  wall.position.z = SHOP_WALL_HEIGHT_M / 2 - wallGroundDropM;

  // Caps the wall's open top so the world reads as fully enclosed -- an
  // upper hemisphere (unit sphere, theta 0..PI/2) whose equator matches
  // the wall's own rim exactly (same radius, continuous gradient color at
  // the seam -- see SHOP_HAZY_HORIZON_COLOR), non-uniformly scaled (X/Z to
  // the wall's radius, Y -- the pole axis before Z-up rotation -- to how far
  // it currently rises) so growShopDomeToHeight can grow it later with a
  // single scale change, no geometry rebuild.
  //
  // owner-report-2026-10-20: widthSegments here used to be 48 against the
  // wall's own 64 radialSegments just above. Matching *radius* alone
  // isn't enough for a seamless rim -- a cylinder/sphere's circular edges
  // are really inscribed N-gons (vertices sit exactly on the circle,
  // straight edges between them sag slightly inward), so a 48-gon and a
  // 64-gon inscribed in the very same circle still sag by different
  // amounts between vertices and only touch exactly at the handful of
  // angles where a vertex of one happens to land near a vertex of the
  // other. That periodic sag-mismatch is what read as jaggedness right at
  // the wall/dome border. Matching widthSegments to the wall's own
  // radialSegments makes the two rims the same 64-gon at the same angles,
  // closing the gap.
  const domeGeometry = new THREE.SphereGeometry(1, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  paintVerticalGradient(domeGeometry, (localY, out) => {
    const t = THREE.MathUtils.clamp(localY, 0, 1);
    out.copy(SHOP_HAZY_HORIZON_COLOR).lerp(SHOP_SKY_DOME_COLOR, t);
  });
  resetShopDomeRiseM();
  // owner-report-2026-10-21: matching segment counts (above) makes the
  // wall's and dome's rims the same ideal 64-gon, but CylinderGeometry
  // and SphereGeometry still compute that shared rim's vertex positions
  // via two different trig code paths (the cylinder's theta parameter
  // isn't the same floating-point expression as the sphere's equivalent
  // phi, even though they describe the same circle -- see #2523's own
  // 90-degree-phase-offset analysis). That leaves a sub-ULP gap/overlap
  // right at the seam, which the depth test resolves inconsistently --
  // worse at a distance, where depth-buffer precision is coarser, and
  // gone up close, exactly matching the owner's own report ("disappears
  // when I try to get closer"): classic z-fighting, not noise. A
  // dedicated material for the dome -- sharing the wall's own `uniforms`
  // object *by reference* (not a deep clone) so both stay on the exact
  // same clock -- with a small polygonOffset settles the ambiguity
  // deterministically in the wall's favor instead of leaving it to
  // whichever float value happens to round which way.
  const domeMaterial = new THREE.ShaderMaterial({
    uniforms: skyMaterial.uniforms,
    vertexShader: SHOP_SKY_VERTEX_SHADER,
    fragmentShader: SHOP_SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    extensions: { derivatives: true },
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const dome = new THREE.Mesh(domeGeometry, domeMaterial);
  dome.rotation.x = Math.PI / 2;
  dome.position.z = SHOP_WALL_HEIGHT_M - wallGroundDropM;
  dome.scale.set(radiusM, shopDomeRiseM, radiusM);

  const objects = [ground, wall, dome];
  return {
    ground, wall, dome, objects, radiusM,
    // Frees the geometries and materials. The sky material is shared by the
    // wall and the dome (the dome's own material only borrows its uniforms);
    // the ground texture is the cached, shared grass and stays.
    dispose() {
      for (const mesh of objects) {
        mesh.parent?.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}
