// #3449 (part of #3444, applying #3397's "things arrive in the world through
// fog; nothing pops in"): an assistant on shift comes into the world out of fog
// and, when its heartbeat lapses, goes back into it. The fog and the dissolve are
// #3406's (arrivalEffect.js); this module is the timeline and the small
// controller that drives them for one avatar entry.
//
// Arrival is the same timeline every arrival uses (arrivalFog.js's
// arrivalLevels, ready at once). Departure is its mirror: the fog rises as the
// assistant dissolves, then thins away. With prefers-reduced-motion there is no
// fog, just a short plain fade.
import { arrivalLevels, ARRIVAL_FOG_RISE_S, ARRIVAL_RESOLVE_S, ARRIVAL_REDUCED_MOTION_FADE_S } from './arrivalFog.js';

export const ASSISTANT_ARRIVE_TOTAL_S = ARRIVAL_FOG_RISE_S + ARRIVAL_RESOLVE_S;
export const ASSISTANT_DEPART_FOG_S = 0.5; // fog thickening while it dissolves
export const ASSISTANT_DEPART_FADE_S = 1.0; // dissolve out
export const ASSISTANT_DEPART_TOTAL_S = 1.5; // everything at rest, the avatar removed

function clamp01(n) {
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

function smoothstep(t) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// { fog, item, done } for an assistant that has just appeared.
export function assistantArrivalLevels(ageS, { reducedMotion = false } = {}) {
  return arrivalLevels(ageS, 0, { reducedMotion });
}

// { fog, item, done } for an assistant that has just left: item 1 -> 0, fog
// 0 -> peak -> 0, done once the fog has gone and the avatar is invisible.
export function assistantDepartureLevels(ageS, { reducedMotion = false } = {}) {
  const age = Math.max(0, Number.isFinite(ageS) ? ageS : 0);
  if (reducedMotion) {
    const t = clamp01(age / ARRIVAL_REDUCED_MOTION_FADE_S);
    return { fog: 0, item: 1 - t, done: t >= 1 };
  }
  const item = 1 - smoothstep(age / ASSISTANT_DEPART_FADE_S);
  const rise = smoothstep(age / ASSISTANT_DEPART_FOG_S);
  const clear = smoothstep((age - ASSISTANT_DEPART_FOG_S) / (ASSISTANT_DEPART_TOTAL_S - ASSISTANT_DEPART_FOG_S));
  return { fog: rise * (1 - clear), item, done: age >= ASSISTANT_DEPART_TOTAL_S };
}

// Drives one transition on an avatar entry. `effects` is { createFog,
// createDissolve } (arrivalEffect.js's, or fakes in a test); `parent` is where
// the fog goes; `levels(ageS)` is one of the two functions above. Call step(nowMs)
// every frame; it returns true once the transition is done and everything it
// created has been released. cancel() releases at once, leaving the avatar fully
// visible (a departing assistant that came back).
export function createAssistantTransition({ entry, parent, effects, levels, startedAtMs, extent = { width: 1.2, depth: 1.2, height: 2.2 } }) {
  const position = entry.group.position;
  const fog = effects.createFog({ center: { x: position.x, y: position.y, z: position.z + 0.2 }, extent, seed: 7 });
  parent.add(fog.object);
  const dissolve = effects.createDissolve(entry.group);
  let released = false;

  function release(finalItem) {
    if (released) return;
    released = true;
    fog.dispose();
    dissolve.restore();
    if (entry.assistantTag) entry.assistantTag.visible = finalItem > 0.5;
  }

  function apply(state) {
    fog.setLevel(state.fog);
    dissolve.setLevel(state.item);
    // The name tag is a sprite (not a dissolving mesh): show it only while the
    // assistant is mostly there, so it never floats over empty air.
    if (entry.assistantTag) entry.assistantTag.visible = state.item > 0.5;
    fog.object.position.set(entry.group.position.x, entry.group.position.y, entry.group.position.z + 0.2);
  }

  apply(levels(0));
  return {
    step(nowMs) {
      if (released) return true;
      const state = levels(Math.max(0, (nowMs - startedAtMs) / 1000));
      if (state.done) {
        release(state.item);
        return true;
      }
      apply(state);
      return false;
    },
    cancel() {
      release(1);
    },
    get released() {
      return released;
    },
  };
}
