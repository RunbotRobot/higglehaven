import * as THREE from 'three';

// #2625 (leaf of #2563, itself part of #2504/#2500's src/main.js module
// split -- see #2503's design comment and #2563's own breakdown comment
// for the full dependency map): Shop mode's sky dome/wall shader material
// and the atmosphere-rise-with-altitude growth logic that keeps the dome
// clearing any build in the world.
//
// Depends on the shop/flightMovement.js leaf (#2624) having landed first
// -- growShopDomeIfNeeded reads shopFlightAltitudeM-adjacent flight state
// owned by that leaf (indirectly, via the shopDomeRiseM cross-coupling
// documented below).
//
// Not contiguous in main.js -- interleaved with shop/flightMovement.js's
// own functions on either side (e.g. applyShopCameraOrientation sits
// right after this group ends there).
//
// shopDomeRiseM/shopDomeMesh cross-coupling (per #2503's design comment,
// quoted on #2563 itself): this module OWNS shopDomeRiseM (the dome's rise
// above the wall's own top, independent of the wall's rim radius) and
// exports a setter for it, same reverse-import shape world/state.js
// already established for cross-cutting mutable state -- shop/
// flightMovement.js's own clampShopCameraHeight/updateShopFlight/
// shopAvatarFootprintCorners read the plain exported `let` binding
// directly (an ES import binding is live, so a read-only consumer needs
// nothing more), but main.js needs to actually reset it when the world is
// rebuilt, which does need the setter (an importing module can't reassign
// another module's `let` itself).
//
// shopDomeMesh itself, along with shopWorldRadiusM and SHOP_WALL_HEIGHT_M/
// SHOP_DOME_CLEARANCE_MARGIN_M, stay owned by main.js (reverse-imported
// here, read-only) -- they're part of the broader world-build function
// that constructs the wall/dome meshes themselves (paintVerticalGradient/
// createShopSkyMaterial's own call sites), which is far more than just
// "sky" (it also builds ground/landlet geometry) and isn't part of this
// leaf's scope. Same reasoning, SHOP_GROUND_HORIZON_COLOR/
// SHOP_HAZY_HORIZON_COLOR/SHOP_SKY_DOME_COLOR (the gradient colors fed
// into paintVerticalGradient's own colorAt callback) stay in main.js too
// -- paintVerticalGradient itself is color-agnostic, so those consts are
// only ever referenced at its call sites, not inside this module.
import { shopDomeMesh, SHOP_WALL_HEIGHT_M, SHOP_DOME_CLEARANCE_MARGIN_M } from '../main.js';

// The dome's rise above the wall's own top — independent of the wall's
// rim radius (set via non-uniform scale, see main.js's own world-build
// function) so a bigger world doesn't need a proportionately taller dome.
// Grows on its own if something built anywhere in the world is ever
// discovered taller than this provides clearance for — see
// growShopDomeIfNeeded.
const SHOP_DOME_INITIAL_RISE_M = SHOP_WALL_HEIGHT_M;

export let shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;
// #2625: main.js's own world-build function resets this to the initial
// rise whenever the world is (re)built -- an ES import binding is
// read-only from the importing side, so it needs this setter rather than
// a direct assignment, same shape world/state.js's own setCurrentMode etc.
// already established.
export function setShopDomeRiseM(value) {
  shopDomeRiseM = value;
}
export function resetShopDomeRiseM() {
  shopDomeRiseM = SHOP_DOME_INITIAL_RISE_M;
}

let shopSkyMaterial = null; // the wall's own material — the dome gets its own material instance (see main.js's own world-build function) sharing this one's `uniforms` object by reference, not the material itself, so both still animate off one clock — see createShopSkyMaterial
let shopSkyClockStart = null;

// Clouds only ever show in the upper portion of the wall (its own hazy-
// horizon band) and above — never near the wall's ground-colored base, so
// the boundary still mostly reads as plain sky/horizon rather than a
// visibly "effects-y" surface. Both are absolute world Z heights (this
// world is Z-up, ground at z=0), independent of shopDomeRiseM growing
// later — see growShopDomeIfNeeded — since growing the dome only extends
// clear sky *above* SHOP_CLOUD_FADE_HIGH_Z, which was already full opacity.
const SHOP_CLOUD_FADE_LOW_Z = SHOP_WALL_HEIGHT_M * 0.55;
const SHOP_CLOUD_FADE_HIGH_Z = SHOP_WALL_HEIGHT_M * 1.25;

// Colors a geometry per-vertex along its own local "up" axis (the axis
// CylinderGeometry/SphereGeometry both author height/pole along before any
// Z-up rotation is applied), calling colorAt(localUp, out) for every
// vertex — a plain vertical gradient needs nothing fancier than that, and
// staying in each geometry's own local space means the result is
// independent of any later position/rotation/scale, so growShopDomeIfNeeded
// scaling the dome taller never has to repaint it.
export function paintVerticalGradient(geometry, colorAt) {
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const out = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    colorAt(position.getY(i), out);
    colors[i * 3] = out.r;
    colors[i * 3 + 1] = out.g;
    colors[i * 3 + 2] = out.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// A soft, slowly swirling cloud layer painted directly over the wall/dome's
// own vertex-color gradient (vColor below — the exact colors
// paintVerticalGradient already wrote) rather than replacing it, so the
// calm horizon/sky look this was tuned to keep is the base case and clouds
// are only ever a translucent overlay on top of it. One shared material
// instance for both meshes (see main.js's own world-build function) keeps
// their animation perfectly in sync and means only one uTime needs
// updating per frame.
//
// The "swirl": each height band drifts around the vertical axis at a
// slightly different azimuthal speed (see the sin(heightFrac...) term in
// `drift` below), so bands shear past each other over time instead of the
// whole sky sliding sideways together — soft, continuous, and slow enough
// to read as soothing rather than busy. World-space position (not each
// geometry's own local parametrization) drives both the swirl angle and
// the height-based fade, so the effect is seamless across the wall/dome
// seam even though they're two separate meshes with different local
// coordinate systems.
export const SHOP_SKY_VERTEX_SHADER = `
  attribute vec3 color;
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  varying vec3 vNormalWorld;
  void main() {
    vColor = color;
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    // See the fragment shader's own owner-report-2026-10-21 comment on
    // grazeFade -- this is purely that fix's input, not used for lighting.
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
export const SHOP_SKY_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  varying vec3 vNormalWorld;
  uniform float uTime;
  uniform float uFadeLowZ;
  uniform float uFadeHighZ;
  uniform float uWorldRadius;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  // Band-limited fbm: each octave is faded out once its own noise-space
  // period gets small relative to how much p itself changes between
  // neighboring screen pixels (fwidth(p)). Without this, looking nearly
  // straight up into the dome compresses a huge sweep of world-space
  // azimuth into a handful of screen pixels near the apex, so the same
  // pixel-to-pixel jump in p covers many full cycles of the higher
  // octaves — undersampling them, which aliases into sharp radiating
  // streaks rather than soft cloud texture. Fading each octave out before
  // that happens leaves only the octaves that are still actually resolved
  // at that pixel, which reads as a smooth (if slightly hazier) blend
  // instead — exactly the soft wisp this was meant to look like everywhere,
  // not just where the view happens to be gentle enough not to alias.
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float totalWeight = 0.0;
    for (int i = 0; i < 4; i++) {
      // #1585: #1190's original thresholds (0.005, 0.05) still left a
      // visible band of sharp-edged, hard-banded streaks (not the soft
      // "slightly hazier blend" this comment promises) wherever footprint
      // landed inside that range but hadn't yet grown large enough to
      // fully fade — confirmed directly: replacing fbm()'s body with a
      // flat constant (no pseudo-random content at all, same geometry/
      // camera) rendered a perfectly smooth gradient with zero streaking,
      // proving the streaks are 100% this noise function's own
      // undersampling, not a mesh seam or z-fighting (the two alternatives
      // issue #1585's own report raised). Widening apexFade's own radius
      // (the pole-proximity cutoff just below) barely changed the result,
      // so the problem wasn't limited to the literal pole either — it's
      // this fade engaging too late. Starting the fade an order of
      // magnitude sooner (0.0005) closes that gap — confirmed via direct
      // visual comparison that every previously-streaked camera angle
      // (near the apex, pitched up and yawed, flying near the horizon)
      // renders cleanly once the fade engages that early.
      //
      // #1799: #1585's own fix additionally narrowed the *upper* bound
      // from 0.05 to 0.006 (a ~9x tighter span, 0.0055 wide vs. the
      // original 0.045), which traded the undersampling streaks for a
      // new, different-looking artifact — a hard, jagged/stair-stepped
      // edge in the cloud overlay, most visible on a pitched-up-and-yawed
      // view (confirmed via direct Playwright screenshots, cropped and
      // contrast-boosted to make it unambiguous). Root cause: fwidth() is
      // a GPU quad-derivative — effectively constant across each 2x2
      // pixel block, not a true per-pixel value — and that inherent
      // blockiness is negligible against a wide threshold span but
      // becomes the dominant signal once the span narrows enough that
      // one quad's worth of footprint jitter covers a large fraction of
      // it, which is exactly what a 0.0055-wide span did. This shows up
      // worst along diagonal gradients (yawed views) because GPU quad
      // derivatives are axis-aligned, so a diagonal transition steps
      // through quads one axis at a time rather than smoothly. Widening
      // the upper bound back out to 0.03 — keeping #1585's early-
      // engaging 0.0005 lower bound (the actual fix for the original
      // streaks), while still well under the pre-#1585 0.05 that let
      // those streaks through — gives the transition enough span again
      // to absorb normal quad-to-quad footprint jitter: confirmed via
      // the same screenshot technique that the jagged edge is gone at
      // every angle that showed it (pitched up and yawed, near the
      // horizon), while a full straight-up apex view and an ordinary
      // moderate-pitch view both still render as a smooth gradient with
      // no streaking, same as #1585's own fix already established.
      // #2716 (fixed, higglehaven3, 2026-10-25): footprint used to be
      // fwidth(p.x) + fwidth(p.y) -- an L1 (axis-aligned) combination of two
      // screen-space derivatives. That combination is NOT rotation-
      // invariant: for a static camera and a perfectly smooth underlying
      // field, rotating only the *sampling* coordinate frame (exactly what
      // swirlAngle does every frame, via the mat2(c,-s,s,c) applied to
      // normalizedXY before this loop runs) still changed the old
      // footprint's value by a factor ranging from 1x to sqrt(2) (~41%)
      // depending purely on swirlAngle's alignment to the screen's x/y axes
      // (higglehaven12's #2716 investigation, confirmed both analytically
      // and via a standalone JS reimplementation with the camera held
      // perfectly static). Since swirlAngle(t) = uTime*0.02 + (bounded
      // shear term) grows monotonically from 0 at page load, it first
      // reached the worst-case 45-degree misalignment at
      // t = (pi/4)/0.02 ~= 39.3s for heightFrac=0.5 (23.1s for
      // heightFrac=0.3) -- squarely inside the owner's reported 20-40s
      // window. Whenever an octave's true (rotation-corrected) footprint
      // sat within ~41% of the 0.0005/0.03 thresholds below, this spurious
      // oscillation alone could flip that octave's fade in and out purely
      // from elapsed time, with a static camera and no grazing/apex
      // involved -- exactly the normal-incidence, avatar-standing-still
      // symptom #2716 reported, and distinct from the GPU-quad fwidth()-
      // blockiness mechanism used elsewhere in this file (this one needs no
      // hardware-specific derivative quantization to manifest, so it was
      // reproducible even on this sandbox's software renderer).
      //
      // Fixed by computing the actually rotation-invariant Frobenius norm
      // of (p.x, p.y)'s own 2x2 screen-space Jacobian directly via dFdx/
      // dFdy, instead of summing two already-rotation-variant fwidth()
      // calls. Rotating a matrix by an orthogonal matrix (any pure rotation
      // like swirlAngle's mat2) never changes its Frobenius norm, for any
      // underlying camera Jacobian whatsoever (isotropic or not) -- so this
      // value no longer oscillates with elapsed time at all for a static
      // camera, eliminating the mechanism outright rather than widening a
      // threshold around it.
      //
      // Scale factor (sqrt(2)): if the camera's own (swirl-independent)
      // screen-space Jacobian has no shear -- its two singular values s1,
      // s2 line up with the screen's own x/y axes, i.e. it's a pure
      // (possibly anisotropic) stretch -- the old L1 entrywise norm of that
      // Jacobian rotated by swirlAngle's own phi reduces exactly to
      // (s1+s2)*(|cos phi|+|sin phi|): a swing of exactly sqrt(2) between
      // its own minimum (s1+s2) at phi=0 mod 90 degrees and its own maximum
      // sqrt(2)*(s1+s2) at phi=45 mod 90, for any s1/s2 ratio (confirmed
      // algebraically here and numerically, per higglehaven12's #2716
      // investigation). sqrt(2) times the (always rotation-invariant)
      // Frobenius norm sqrt(s1^2+s2^2) lands exactly at that old minimum
      // when s1=s2 (locally isotropic -- a reasonable approximation for a
      // dome's own screen-space derivatives, given its fairly uniform
      // curvature) and drifts toward the old maximum as s1/s2 diverge, but
      // either way stays inside that no-shear case's own already-tested
      // [minimum, maximum] span.
      // A *sheared* Jacobian (its singular vectors not axis-aligned with
      // the screen) breaks that clean reduction -- confirmed numerically
      // (see src/shop/sky.test.js) that sqrt(2)*Frobenius can then land
      // slightly outside the old formula's own rotation-swept [min, max]
      // for that specific sheared case (observed up to roughly 13% below
      // the old minimum for one deliberately-skewed test matrix), not an
      // exact match. The weaker, always-true bound for *any* Jacobian
      // shape, sheared or not, is the standard entrywise-vs-Frobenius norm
      // inequality: Frobenius <= old L1 <= 2*Frobenius always, so
      // sqrt(2)*Frobenius (strictly between those two bounds) can never
      // differ from the old formula's own true scale by more than a factor
      // of roughly sqrt(2) in either direction even in the worst case --
      // nowhere near enough to reintroduce the original undersampling
      // streaks (#1585/#1799) or bring back a meaningfully different
      // fade-threshold crossing than before. Either way, the actual bug
      // this fixes -- the value oscillating with *elapsed time* for a
      // *static* camera, purely from swirlAngle's own rotation -- is gone
      // unconditionally, regardless of whether the real camera Jacobian
      // happens to be sheared; only the fine calibration against the old
      // formula's exact historical scale is an approximation in that case,
      // not the core fix.
      // A future session with real GPU access should still re-verify
      // directly against the owner's reported timing/camera setup, same as
      // any shader change in this file, but this removes the one mechanism
      // #2716's own analysis found that needs no GPU-specific behavior to
      // reproduce, so it's expected to be the actual fix rather than
      // another unconfirmed mitigation. See src/shop/sky.test.js for a
      // pure-JS mirror of this derivation (kept in sync with the formula
      // below by hand, since GLSL isn't executable there).
      float dpxdX = dFdx(p.x);
      float dpxdY = dFdy(p.x);
      float dpydX = dFdx(p.y);
      float dpydY = dFdy(p.y);
      float footprint = sqrt(2.0) * sqrt(dpxdX * dpxdX + dpxdY * dpxdY + dpydX * dpydX + dpydY * dpydY);
      float fade = 1.0 - smoothstep(0.0005, 0.03, footprint);
      value += amplitude * fade * noise(p);
      totalWeight += amplitude * fade;
      p *= 2.05;
      amplitude *= 0.55;
    }
    // Renormalize so fading out high octaves near the apex converges the
    // result toward the (still fully resolved) low-frequency base rather
    // than just going dim/dark — a change in texture, not in brightness.
    return totalWeight > 0.0001 ? value / totalWeight : value;
  }

  void main() {
    float heightFrac = clamp((vWorldPosition.z - uFadeLowZ) / (uFadeHighZ - uFadeLowZ), 0.0, 1.0);
    // Rotating the actual XY position (not an extracted angle) around the
    // vertical axis avoids a polar singularity — sampling noise by angle
    // alone makes every point near the dome's apex, however close
    // together, resolve to wildly different angles, which reads as sharp
    // rays converging to a point rather than soft cloud cover. Rotating
    // real coordinates has no such singularity: nearby points stay nearby.
    // Each height band rotates at a slightly different rate so bands shear
    // past each other over time — that shear is what actually reads as
    // "swirl." Split into two terms: a uniform rotation (same for every
    // height, so it has zero derivative w.r.t. heightFrac and is safe to
    // keep accumulating forever) plus a height-dependent shear term.
    //
    // #1190: the height-dependent term used to be uTime * 0.015 *
    // sin(heightFrac * 2pi) -- i.e. its own magnitude grew linearly with
    // elapsed time forever. That means d(swirlAngle)/d(heightFrac), which
    // directly drives how far apart in noise-space two vertically adjacent
    // pixels sample, also grew linearly with uTime without bound: after
    // long enough in Shop mode, adjacent height rows' samples became far
    // enough apart to alias, visible as a seam/band (confirmed via direct
    // footprint-heatmap debugging: fwidth(samplePos) spikes in a band near
    // the horizon after ~20 simulated minutes, exactly where the normal
    // render shows a washed-out edge, and is flat at t=0). Capping the
    // term's own magnitude with a slow oscillating envelope instead of
    // letting it grow linearly keeps that derivative bounded for any
    // session length, while matching the original's instantaneous rate at
    // t=0 (so a normal, short session looks identical to before).
    float shearOmega = 0.0104719755; // 2*pi / 600s -- full envelope cycle every 10 minutes
    float shearAmplitude = 1.4323944878; // 0.015 / shearOmega, so d/dt at t=0 matches the original 0.015 rad/s
    float swirlAngle = uTime * 0.02 + shearAmplitude * sin(shearOmega * uTime) * sin(heightFrac * 6.2831);
    float s = sin(swirlAngle);
    float c = cos(swirlAngle);
    // Normalized by the world's own current radius (not a fixed meters
    // scale) so the pattern always spans the same handful of cells around
    // the dome regardless of how big the world currently is — a fixed
    // meters-based frequency would compress into a single, texture-less
    // noise cell for a small early-game world, or tile too busily once the
    // world has grown large.
    vec2 normalizedXY = vWorldPosition.xy / max(uWorldRadius, 1.0);
    vec2 swirled = mat2(c, -s, s, c) * normalizedXY;
    // owner-report-2026-10-20 (regression on #2450): this offset used to be
    // vec2(uTime * 0.05, heightFrac * 3.0 - uTime * 0.015) -- i.e. its own
    // magnitude grew linearly with elapsed time forever, exactly the same
    // unbounded-growth shape #1204 already fixed once for the swirl term
    // just above (which is why that term is now safe: it's only ever
    // consumed via sin/cos, so it's inherently periodic). This offset
    // wasn't, so the fbm sample neighborhood wandered forever through
    // fresh noise-space. #2450's widened cloudMask hides an ordinary
    // *steady-state* gradient near the pole, but it can't hide an
    // arbitrarily steep one -- and an unbounded random walk through noise
    // space will eventually (by chance) wander back into one, reproducing
    // the original artifact after a few minutes (confirmed via simulated-
    // duration testing with a dilated RAF clock, same technique #1204's
    // own "verified clean up to ~27.7 hours" claim must have used: the
    // artifact's severity visibly fluctuates and worsens over the first
    // ~20 simulated minutes rather than settling down). Fixed the same way
    // #1204 fixed the shear term: a bounded oscillating envelope instead
    // of unbounded linear growth, matching the original's instantaneous
    // rate at t=0 so a short session still looks identical to before, and
    // sharing shearOmega's own 600s cycle length for consistency.
    float driftAmplitudeX = 4.7746482927; // 0.05 / shearOmega, matches d/dt at t=0
    float driftAmplitudeY = -1.4323944878; // -0.015 / shearOmega, matches d/dt at t=0
    vec2 drift = vec2(driftAmplitudeX, driftAmplitudeY) * sin(shearOmega * uTime);
    vec2 samplePos = swirled * 2.5 + vec2(drift.x, heightFrac * 3.0 + drift.y);
    float clouds = fbm(samplePos);
    // #1190/#1585/#1799/owner-report-2026-10-20: three prior fixes in this
    // area (apex-streak footprint-fade tuning, shear-band envelope capping,
    // footprint-threshold widening/narrowing) all targeted *aliasing* —
    // undersampled high-frequency noise. Direct visual debugging this time
    // (rendering fbm()'s raw, unprocessed output with visibility forced to
    // 0/1 at a time) found something different: even the *smooth*,
    // correctly-resolved, non-aliased base octave shows a soft radial
    // "spoke" pattern converging on the pole. This isn't noise undersampling
    // at all — it's an unavoidable consequence of rotating the flattened
    // (x,y) world position (normalizedXY below) around the pole: every
    // azimuth's sample position approaches the *same* noise-space point as
    // world-space radius shrinks toward the pole (a sphere's pole is a
    // single point — any 2D flattening must collapse every azimuth there),
    // so a smooth noise gradient near that point reads as straight
    // "contour" lines radiating outward once you're close enough. No amount
    // of per-octave aliasing suppression touches this, because it's present
    // in the lowest octave too, which that mechanism never fades.
    // What actually fixes the *visible* symptom: the previous narrow
    // smoothstep(0.25, 0.95, clouds) turned this smooth radial gradient
    // into a near-binary cloud/no-cloud mask, and it's that hard threshold
    // — not the underlying gradient — that reads as sharp "spokes"/"bands"
    // rather than a soft, barely-noticeable undulation. Widening the
    // threshold dramatically (confirmed via a full yaw sweep at a fixed
    // steep pitch, not just one camera angle) keeps the same underlying
    // field but blends it so softly that the radial structure stops being
    // perceptible, without touching the swirl/shear-band fix (#1204) or the
    // per-octave aliasing fade (#1633) at all.
    // owner-report-2026-10-20 (round 2, post-deploy): even with the
    // drift term now bounded (see samplePos above) and this threshold
    // already once widened by #2450, a sharp-edged patch is still
    // occasionally visible near the wall/dome boundary. heightFrac is
    // already fairly low there (uFadeLowZ sits well below the boundary,
    // but the ramp isn't finished by the time visibility is still
    // substantial at that height -- see heightFrac's own definition
    // above), so a locally steep spot in the (now-bounded, but not
    // perfectly flat) noise field is still enough to read as a hard edge
    // once multiplied back up by a non-trivial heightFrac. Widening this
    // threshold again trades a little more of the cloud layer's own
    // contrast for a softer worst case everywhere, same direction as
    // #2450's own change and with the same confirmed-safe-to-widen
    // precedent noted below for apexFade.
    //
    // #2716 (owner report, 2026-10-21/22): a dark, hard-edged diagonal band
    // appearing 20-40s after page load at normal incidence (grazeFade below
    // doesn't apply there -- facing is ~1). The swirl/drift envelope terms
    // above are bounded but keep growing in magnitude for the first ~150s
    // (a quarter of their 600s cycle), so the noise-space neighborhood they
    // sweep through keeps changing during that window -- plausibly wandering
    // into a locally steeper patch of the (otherwise still-bounded) field at
    // some point in that stretch, same "steep spot crosses a hard value
    // threshold" shape every fix in this block already targets. Not
    // independently confirmed on this sandbox's software renderer, which
    // this issue's own investigation already found under-reproduces this
    // artifact class relative to real GPU hardware (see the issue for the
    // repro-harness details) -- widening further here is the same
    // zero-regression-risk mitigation #2450/round-2 already established for
    // this exact failure mode, not a newly-confirmed fix. A future session
    // with real GPU access should re-verify directly against the owner's
    // reported timing/camera setup.
    //
    // higglehaven12, 2026-10-24: a from-scratch numeric simulation of this
    // issue found this threshold-widening mechanism's worst-case per-pixel
    // step, under realistic camera parameters, too small (~0.0002-0.0004
    // out of a 0-1 visibility range) to plausibly read as a "hard" edge,
    // and its worst timing scattered essentially randomly across 0-90s
    // rather than clustering at 20-40s -- i.e. this mechanism likely wasn't
    // the actual cause. A different, rotation-alignment-driven mechanism in
    // fbm()'s own footprint/fade loop above matched the reported 20-40s
    // timing far more precisely and needed no GPU-specific derivative
    // quantization to manifest -- see that loop's own #2716 comment for the
    // fix actually shipped (higglehaven3, 2026-10-25): a rotation-invariant
    // Frobenius-norm footprint in place of the old rotation-variant
    // fwidth()-sum one. This cloudMask widening remains in place as a
    // harmless pre-existing margin, not the fix.
    float cloudMask = smoothstep(-1.0, 2.0, clouds);
    // Kept from before (#1204/#1585) as a modest extra safety margin right
    // at the literal pole specifically — on its own this barely moves the
    // result (confirmed: widening or disabling it entirely, independent of
    // the cloudMask change above, made no meaningful visual difference —
    // the real fix is the threshold softening above). length(normalizedXY)
    // is the pole-distance in sin(angle-from-zenith) terms, independent of
    // the current world radius — 0 at the apex, growing toward the horizon.
    float apexFade = smoothstep(0.0, 0.08, length(normalizedXY));
    // owner-report-2026-10-21 (round 3): none of the fixes above touch a
    // different failure mode from the same fbm() footprint-fade logic --
    // confirmed via a from-scratch repro harness (matching wall/dome
    // geometry+shader at the real production world's own scale, since the
    // only sandbox account available keeps every camera distance inside the
    // depth buffer's high-precision near range, same limitation #2606's own
    // honesty check flagged) that isolated the *dome* mesh alone (wall
    // hidden entirely) as sufficient to reproduce a crisp, stair-stepped
    // crack through the sky -- present identically regardless of the wall,
    // regardless of #2606's polygonOffset (even at 1000x its shipped
    // magnitude), and regardless of giving the dome real (multi-meter, not
    // sub-ULP) geometric overlap with the wall. Forcing cloudMask's own
    // visibility contribution to zero made the crack vanish outright, which
    // the wall/dome-seam theory never explained: this was the fbm()
    // footprint-threshold aliasing from #1585/#1799 all along, just not
    // triggered by any camera angle those two fixes were tuned against --
    // true grazing/near-tangential incidence (flying close alongside the
    // wall, looking almost straight along it) drives fwidth(p) for *every*
    // octave far past even #1799's widened 0.03 upper bound, and GPU quad-
    // derivative blockiness turns that threshold crossing into a visible
    // stair-step rather than a smooth fade, exactly as #1799's own comment
    // already predicted for this mechanism in general.
    // Widening the threshold a third time would eventually hit the same
    // wall again at a steep enough angle, so this instead fades the cloud
    // overlay itself out as the view approaches grazing incidence against
    // the dome/wall surface -- a Fresnel-style facing term, not another
    // footprint-threshold tweak. facing is 1.0 looking straight at the
    // surface (normal viewing, including straight up at the zenith) and
    // approaches 0.0 at true grazing/tangential incidence, exactly where
    // fwidth()'s blockiness becomes visible. Confirmed via the same repro
    // harness across every previously-clean case (zenith, moderate-pitch
    // ground view, realistic near-wall flight) that this is pixel-identical
    // to the unfixed shader -- the fade only ever engages in the narrow
    // facing range right at the silhouette, where a human player is never
    // looking at ordinary cloud detail anyway. 0.35 was the narrowest
    // margin that still fully cleared the crack even at a deliberately
    // pathological near-impossible test angle (camera 0.2m from a 300m-
    // radius wall, pitch 2°, almost perfectly tangential) with headroom.
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float facing = abs(dot(normalize(vNormalWorld), viewDir));
    float grazeFade = smoothstep(0.0, 0.35, facing);
    float visibility = heightFrac * cloudMask * apexFade * grazeFade * 0.5; // kept subtle — an overlay, not a repaint
    vec3 cloudColor = vec3(0.99, 0.99, 1.0);
    gl_FragColor = vec4(mix(vColor, cloudColor, visibility), 1.0);
  }
`;

export function createShopSkyMaterial(worldRadiusM) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFadeLowZ: { value: SHOP_CLOUD_FADE_LOW_Z },
      uFadeHighZ: { value: SHOP_CLOUD_FADE_HIGH_Z },
      uWorldRadius: { value: worldRadiusM },
    },
    vertexShader: SHOP_SKY_VERTEX_SHADER,
    fragmentShader: SHOP_SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    // fwidth() in fbm() (used to band-limit the noise near the dome apex,
    // see fbm's own comment) needs this extension under WebGL1/GLSL ES
    // 1.00; harmless no-op where the renderer already exposes it as core
    // (WebGL2).
    extensions: { derivatives: true },
  });
}

// #2625: main.js's own world-build function needs the material instance
// itself (to construct the wall's own Mesh, and to read its `.uniforms`
// object by reference for the dome's own separate material -- see that
// function's own comment) but has no business reaching into this
// module's private shopSkyMaterial/shopSkyClockStart state directly to
// get it -- this bundles createShopSkyMaterial's own construction with
// resetting the shared clock (same "bundle a multi-field reset into one
// exported function" shape as shop/avatar.js's own
// resetShopAvatarIdleState, #2623) and returns the material so the caller
// never needs write access to this module's internals.
export function initShopSkyMaterial(worldRadiusM) {
  shopSkyMaterial = createShopSkyMaterial(worldRadiusM);
  shopSkyClockStart = null;
  return shopSkyMaterial;
}

// Called every animate() frame while Shop mode is active (see animate's own
// dispatch) — advances the shared sky material's clock. A local clock
// start rather than reusing `now` directly so the shader's time uniform
// stays small/precise regardless of how long the page has been open before
// Shop mode was entered.
export function updateShopSky(now) {
  if (!shopSkyMaterial) return;
  if (shopSkyClockStart === null) shopSkyClockStart = now;
  shopSkyMaterial.uniforms.uTime.value = (now - shopSkyClockStart) / 1000;
}

// #2716: lets a test (or a future investigation session with real GPU
// access) jump the shared sky clock straight to a specific elapsed time --
// e.g. the owner-reported artifact's own 20-40s window -- instead of
// waiting on real wall-clock time or dilating requestAnimationFrame to get
// there. Sets both uTime directly (so the very next render already reflects
// it) and shopSkyClockStart (so a subsequent real updateShopSky(now) tick
// continues advancing smoothly from this point rather than snapping back).
// Always inert unless a test calls it, same convention as every other
// window.__test* hook.
export function setShopSkyElapsedSecondsForTest(now, elapsedSeconds) {
  if (!shopSkyMaterial) return;
  shopSkyClockStart = now - elapsedSeconds * 1000;
  shopSkyMaterial.uniforms.uTime.value = elapsedSeconds;
}

// #2717: a read-only accessor so the render-state ring buffer (src/
// feedback/renderStateBuffer.js) can sample uTime's current value without
// reaching into this module's own private shopSkyMaterial state directly —
// same "export a getter instead of exposing the private field" shape this
// module already uses for shopDomeRiseM (see setShopDomeRiseM/
// resetShopDomeRiseM above). Returns null before initShopSkyMaterial has
// ever run (no active Shop session yet).
export function currentShopSkyTimeS() {
  return shopSkyMaterial ? shopSkyMaterial.uniforms.uTime.value : null;
}

// Called as each Shop-mode landlet's instances load in (see
// loadShopLandletInstances) — if anything anywhere in the world turns out
// to be tall enough to threaten poking through the dome, grow the dome to
// keep clearing it rather than ever letting a real build clip through a
// backdrop. Purely reactive to what's actually been loaded so far (Shop
// only loads a landlet's instances once the camera gets near it — see
// updateShopProximity), not a global precomputed guarantee.
export function growShopDomeIfNeeded(object) {
  if (!shopDomeMesh) return;
  const box = new THREE.Box3().setFromObject(object);
  const neededRise = box.max.z - SHOP_WALL_HEIGHT_M + SHOP_DOME_CLEARANCE_MARGIN_M;
  if (neededRise <= shopDomeRiseM) return;
  shopDomeRiseM = neededRise;
  shopDomeMesh.scale.y = shopDomeRiseM;
}
