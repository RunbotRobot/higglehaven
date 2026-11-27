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

// #4067: the other half. The person's avatar is not shown as the default body first and swapped; until the
// model they wear is known and ready there is fog where they stand and no body at all ("everything built is
// shown as itself, never a stand-in"; "things arrive in the world through fog"). The fog rises as above
// (AVATAR_SWAP_FOG_RISE_S) and then HOLDS at its peak, following the avatar, until resolve(commit) says the
// answer is in: commit() puts the right body in place (the worn model, or the default for someone who wears
// it), at the peak, and the fog thins away over AVATAR_SWAP_FOG_CLEAR_S. Moving never waits on it: the fog
// travels with the avatar. A hold that is cancelled still runs commit, so a body is never lost.
export function beginAvatarFogHold({
  createFog, parent, getPosition, nowMs, reducedMotion = false,
  extent = { width: 1.2, depth: 1.2, height: 2.2 },
}) {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let commitFn = null;
  let resolvedAt = null; // when resolve() was called (ms)
  let committed = false;
  let released = false;
  let fog = null;
  if (!reducedMotion && createFog) {
    const start = getPosition();
    fog = createFog({ center: { x: start.x, y: start.y, z: start.z + 0.2 }, extent, seed: 11 });
    parent.add(fog.object);
  }

  function doCommit() {
    if (committed) return;
    committed = true;
    try { if (commitFn) commitFn(); } finally { resolveDone(); }
  }
  function release() {
    if (released) return;
    released = true;
    fog?.dispose();
    doCommit();
  }

  return {
    // The answer is in: `commit` puts the right body in place when the fog is at its peak.
    resolve(commit) {
      if (released) { commit(); return; } // the hold is already over (cancelled): just put the body in place
      if (resolvedAt !== null) return;
      commitFn = commit;
      if (!fog) { release(); return; } // reduced motion (or no fog): no fog to wait for
      resolvedAt = performance.now();
    },
    step(now) {
      if (released) return true;
      if (!fog) return false; // #4579: reduced motion (or no fog): nothing to draw until resolve() releases the hold
      const rise = Math.max(0, (now - nowMs) / 1000);
      let level = smoothstep(rise / AVATAR_SWAP_FOG_RISE_S);
      if (resolvedAt !== null && rise >= AVATAR_SWAP_FOG_RISE_S) {
        // Resolved and at the peak: the body goes in now, then the fog thins.
        doCommit();
        const clearS = Math.max(0, (now - Math.max(resolvedAt, nowMs + AVATAR_SWAP_FOG_RISE_S * 1000)) / 1000);
        level = 1 - smoothstep(clearS / AVATAR_SWAP_FOG_CLEAR_S);
        if (clearS >= AVATAR_SWAP_FOG_CLEAR_S) {
          release();
          return true;
        }
      } else if (resolvedAt !== null) {
        level = smoothstep(rise / AVATAR_SWAP_FOG_RISE_S); // still rising: the peak is not reached yet
      }
      const position = getPosition();
      fog.setLevel(level);
      fog.object.position.set(position.x, position.y, position.z + 0.2);
      return false;
    },
    cancel() { release(); },
    done,
    get released() { return released; },
  };
}
