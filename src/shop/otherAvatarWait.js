// #4067 (applying #3397's "things arrive in the world through fog; nothing pops in" and #3412's
// "never replaced by a stand-in"): someone who wears an avatar is not drawn as the default body while
// the model they wear is still loading. Soft fog stands where they stand, holds for as long as the
// load takes, and thins away over the body when it is put in place. The fog itself is arrivalEffect.js's
// (#3406); this is the timeline and the small controller that drives it for one avatar entry, with
// nothing in it that knows three.js so it is unit-testable. With prefers-reduced-motion there is no
// fog, and nothing is drawn for them until the model is ready (still never a stand-in).
export const WAIT_FOG_RISE_S = 0.4; // fog thickening where they stand
export const WAIT_FOG_HOLD = 0.85; // how thick it holds while the model loads
export const WAIT_FOG_CLEAR_S = 0.7; // fog thinning away over the real body

function clamp01(n) {
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

function smoothstep(t) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// The fog level (0..1) `ageS` seconds after it began; `readyAgeS` is the age at which the model was
// put in place, or null while it is still loading. { fog, done }.
export function waitFogLevel(ageS, readyAgeS = null) {
  const age = Math.max(0, Number.isFinite(ageS) ? ageS : 0);
  const held = (a) => WAIT_FOG_HOLD * smoothstep(a / WAIT_FOG_RISE_S);
  if (readyAgeS === null) return { fog: held(age), done: false };
  const peak = held(readyAgeS);
  const clear = smoothstep((age - readyAgeS) / WAIT_FOG_CLEAR_S);
  return { fog: peak * (1 - clear), done: age - readyAgeS >= WAIT_FOG_CLEAR_S };
}

// Starts the wait for one avatar. `createFog` is arrivalEffect.js's createArrivalFog (or a fake in a
// test); `parent` is where the fog goes; `getPosition()` is where they stand now (they move, so the fog
// follows). Returns { step(nowMs) -> true once everything it made is released, ready(nowMs), cancel() }.
export function beginOtherAvatarWait({
  createFog, parent, getPosition, nowMs, reducedMotion = false,
  extent = { width: 1.2, depth: 1.2, height: 2.2 },
}) {
  if (reducedMotion || !createFog) {
    let released = false;
    return { step: () => released, ready() { released = true; }, cancel() { released = true; } };
  }
  const start = getPosition();
  const fog = createFog({ center: { x: start.x, y: start.y, z: start.z + 0.2 }, extent, seed: 13 });
  parent.add(fog.object);
  let readyAtMs = null;
  let released = false;

  function release() {
    if (released) return;
    released = true;
    fog.dispose();
  }

  return {
    step(now) {
      if (released) return true;
      const p = getPosition();
      fog.object.position.set(p.x, p.y, p.z + 0.2);
      const readyAge = readyAtMs === null ? null : Math.max(0, (readyAtMs - nowMs) / 1000);
      const { fog: level, done } = waitFogLevel(Math.max(0, (now - nowMs) / 1000), readyAge);
      fog.setLevel(level);
      if (done) release();
      return released;
    },
    ready(now) {
      if (readyAtMs === null) readyAtMs = now;
    },
    cancel: release,
  };
}
