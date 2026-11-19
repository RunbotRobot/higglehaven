// #3905 (leaf of #3873, applying #3397's "things arrive in the world through fog; nothing pops in"):
// the shopper's own avatar is first the default body, and the equipped one is swapped in when its model
// arrives. This is the timeline and the small controller that hides that swap in fog: the fog rises over
// the avatar, the swap happens while it is at its peak, then the fog thins away. The fog itself is
// arrivalEffect.js's (#3406); nothing here knows about three.js, so it is unit-testable.
//
// With prefers-reduced-motion there is no fog: the swap happens at once.
export const AVATAR_SWAP_FOG_RISE_S = 0.4; // fog thickening over the default body
export const AVATAR_SWAP_FOG_CLEAR_S = 0.7; // fog thinning away over the new body
export const AVATAR_SWAP_TOTAL_S = AVATAR_SWAP_FOG_RISE_S + AVATAR_SWAP_FOG_CLEAR_S;

function clamp01(n) {
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

function smoothstep(t) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// { fog, swap, done } at `ageS` seconds: fog 0 -> 1 -> 0, `swap` true from the moment the fog is at its
// peak (the real body may be put in place then), `done` once the fog has gone.
export function avatarSwapLevels(ageS) {
  const age = Math.max(0, Number.isFinite(ageS) ? ageS : 0);
  if (age < AVATAR_SWAP_FOG_RISE_S) {
    return { fog: smoothstep(age / AVATAR_SWAP_FOG_RISE_S), swap: false, done: false };
  }
  const clear = smoothstep((age - AVATAR_SWAP_FOG_RISE_S) / AVATAR_SWAP_FOG_CLEAR_S);
  return { fog: 1 - clear, swap: true, done: age >= AVATAR_SWAP_TOTAL_S };
}

// Starts one swap. `createFog` is arrivalEffect.js's createArrivalFog (or a fake in a test); `parent` is
// where the fog goes; `getPosition()` is where the avatar stands now (it moves every frame, so the fog
// follows it); `commit()` puts the real body in place. Returns { step(nowMs), cancel(), done }: call
// step each frame until it returns true. `done` is a promise that resolves once `commit` has run (the
// real body is on screen), so callers can treat the avatar as settled without waiting for the fog to
// finish thinning.
export function beginAvatarSwapFog({
  createFog, parent, getPosition, commit, nowMs, reducedMotion = false,
  extent = { width: 1.2, depth: 1.2, height: 2.2 },
}) {
  if (reducedMotion || !createFog) {
    commit();
    return { step: () => true, cancel() {}, done: Promise.resolve(), get released() { return true; } };
  }
  const start = getPosition();
  const fog = createFog({ center: { x: start.x, y: start.y, z: start.z + 0.2 }, extent, seed: 11 });
  parent.add(fog.object);
  let released = false;
  let committed = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function doCommit() {
    if (committed) return;
    committed = true;
    try { commit(); } finally { resolveDone(); }
  }

  function release() {
    if (released) return;
    released = true;
    fog.dispose();
    doCommit(); // a cancelled swap still puts the real body in place: never lose it
  }

  return {
    step(now) {
      if (released) return true;
      const state = avatarSwapLevels(Math.max(0, (now - nowMs) / 1000));
      if (state.swap) doCommit();
      if (state.done) {
        release();
        return true;
      }
      const position = getPosition();
      fog.setLevel(state.fog);
      fog.object.position.set(position.x, position.y, position.z + 0.2);
      return false;
    },
    cancel() {
      release();
    },
    done,
    get released() {
      return released;
    },
  };
}
