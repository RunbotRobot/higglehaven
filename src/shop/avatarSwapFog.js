// #3905 (leaf of #3873): when the equipped avatar's model arrives after the world is already showing, the
// player's own body changes shape once. "Things arrive in the world through fog; nothing pops in" (AGENTS.md,
// #3397): soft fog rises around the avatar, the models are swapped while it is thickest, and the real body
// resolves out of it as the fog thins. The pieces are #3406's (arrivalEffect.js, the same fog and dissolve an
// assistant comes into the world with, assistantFog.js); this module is the timeline and the small
// controller. Unlike another person's avatar, the player's own moves every frame, so the fog follows the
// avatar that is on screen. With prefers-reduced-motion there is no fog: the swap happens at once.
import { createArrivalFog, createArrivalDissolve } from './arrivalEffect.js';

export const SWAP_FOG_RISE_S = 0.35; // fog thickening around the default avatar
export const SWAP_RESOLVE_S = 0.6; // fog thinning while the real body resolves
export const SWAP_TOTAL_S = SWAP_FOG_RISE_S + SWAP_RESOLVE_S;

const clamp01 = (n) => (n <= 0 ? 0 : n >= 1 ? 1 : n);
const smoothstep = (t) => { const c = clamp01(t); return c * c * (3 - 2 * c); };

// { fog, item, swap, done } at `ageS` seconds after the equipped model was ready. `swap` is true from the
// moment the models change (the fog's peak); `item` is how much of the incoming body is drawn (0 before it).
export function avatarSwapLevels(ageS, { reducedMotion = false } = {}) {
  const age = Math.max(0, Number.isFinite(ageS) ? ageS : 0);
  if (reducedMotion) return { fog: 0, item: 1, swap: true, done: true };
  if (age < SWAP_FOG_RISE_S) return { fog: smoothstep(age / SWAP_FOG_RISE_S), item: 0, swap: false, done: false };
  const t = (age - SWAP_FOG_RISE_S) / SWAP_RESOLVE_S;
  return { fog: 1 - smoothstep(t), item: smoothstep(t), swap: true, done: age >= SWAP_TOTAL_S };
}

let active = null;

// Begins the transition. `swap()` replaces the avatar (it must make `getAvatar()` return the incoming one);
// `abort()` drops the incoming one without showing it (the transition was cancelled before the swap).
// `getAvatar()` is whichever avatar is on screen, followed by the fog. `effects` is { createFog,
// createDissolve } (the real ones, or fakes in a test).
export function startAvatarSwapTransition({
  parent, getAvatar, swap, abort = () => {}, startedAtMs, reducedMotion = false,
  effects = { createFog: createArrivalFog, createDissolve: createArrivalDissolve },
}) {
  cancelAvatarSwapTransition();
  if (reducedMotion) {
    swap();
    return null;
  }
  const start = getAvatar()?.group?.position ?? { x: 0, y: 0, z: 0 };
  const fog = effects.createFog({
    center: { x: start.x, y: start.y, z: start.z + 0.9 },
    extent: { width: 1.2, depth: 1.2, height: 2.2 },
    seed: 13,
  });
  parent.add(fog.object);
  let dissolve = null;
  let swapped = false;
  let released = false;

  function release() {
    if (released) return;
    released = true;
    fog.dispose();
    parent.remove?.(fog.object);
    dissolve?.restore();
  }

  const transition = {
    // Returns true once everything is finished and released.
    step(nowMs) {
      if (released) return true;
      const state = avatarSwapLevels(Math.max(0, (nowMs - startedAtMs) / 1000));
      if (state.swap && !swapped) {
        swapped = true;
        swap();
        const incoming = getAvatar();
        dissolve = incoming ? effects.createDissolve(incoming.group) : null;
      }
      dissolve?.setLevel(state.item);
      fog.setLevel(state.fog);
      const position = getAvatar()?.group?.position;
      if (position) fog.object.position.set(position.x, position.y, position.z + 0.9);
      if (state.done) {
        release();
        if (active === transition) active = null;
        return true;
      }
      return false;
    },
    // Releases everything at once. Before the swap the incoming body is dropped; after it, it is left whole.
    cancel() {
      if (!swapped) {
        swapped = true;
        abort();
      }
      release();
      if (active === transition) active = null;
    },
  };
  active = transition;
  transition.step(startedAtMs);
  return transition;
}

export function cancelAvatarSwapTransition() {
  active?.cancel();
  active = null;
}

// Called every frame by the movement core (src/shop/flightMovement.js), in Shop and in Sell's world view.
export function stepAvatarSwapTransition(nowMs) {
  if (active) active.step(nowMs);
}

// What Shop and Sell's world view hand to mountShopAvatar as `runSwap`: the transition on the real fog, started now,
// with the person's own motion preference.
export function runAvatarSwapFog(scene, { swap, abort, getAvatar }) {
  let reducedMotion = false;
  try { reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { /* motion is the default */ }
  return startAvatarSwapTransition({ parent: scene, getAvatar, swap, abort, startedAtMs: performance.now(), reducedMotion });
}
