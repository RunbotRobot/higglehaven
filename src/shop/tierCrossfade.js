// #3494 (from #3443 item 3, under #3412): when a placed item changes between its
// full, middle and far versions, the incoming version dissolves in over the
// outgoing one (the dither from arrivalEffect.js) and the outgoing one is hidden
// when it finishes, instead of the two swapping in a single frame.
//
//   const fades = createTierCrossfades();
//   fades.start(object, outgoingChildren, incomingChildren);  // false: swap instantly
//   fades.finish(object);                                     // settle one object now
//   fades.update();                                           // every frame
//
// Both versions draw while a fade runs, so the number in flight is capped (the
// nearest-first order in which the caller flips items decides who gets one; the
// rest swap instantly). A person who prefers reduced motion always swaps
// instantly. The incoming version's materials are cloned once per fade by
// createArrivalDissolve and given back at the end, so a landlet at rest costs
// nothing.
import { createArrivalDissolve } from './arrivalEffect.js';

export const TIER_CROSSFADE_MS = 300;
export const TIER_CROSSFADE_MAX_IN_FLIGHT = 16;

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createTierCrossfades({
  createDissolve = (root) => createArrivalDissolve(root, { uniformName: 'uTierFadeLevel' }),
  clock = () => performance.now(),
  durationMs = TIER_CROSSFADE_MS,
  maxInFlight = TIER_CROSSFADE_MAX_IN_FLIGHT,
  reducedMotion = prefersReducedMotion,
} = {}) {
  const inFlight = new Map(); // object -> { startMs, outgoing, dissolves }

  function settle(object, fade) {
    inFlight.delete(object);
    for (const child of fade.outgoing) child.visible = false;
    for (const dissolve of fade.dissolves) dissolve.restore();
  }

  return {
    get inFlightCount() {
      return inFlight.size;
    },
    // Makes `incoming` visible dissolving in while `outgoing` stays drawn.
    // Returns false (nothing changed) when the caller should swap instantly.
    start(object, outgoing, incoming) {
      if (!outgoing.length || !incoming.length) return false;
      if (inFlight.size >= maxInFlight || reducedMotion()) return false;
      const dissolves = incoming.map((child) => createDissolve(child));
      for (const dissolve of dissolves) dissolve.setLevel(0);
      for (const child of incoming) child.visible = true;
      inFlight.set(object, { startMs: clock(), outgoing, dissolves });
      return true;
    },
    // Ends an object's fade at once (a newer swap, or an unload).
    finish(object) {
      const fade = inFlight.get(object);
      if (fade) settle(object, fade);
    },
    update() {
      if (!inFlight.size) return;
      const nowMs = clock();
      for (const [object, fade] of [...inFlight]) {
        const level = (nowMs - fade.startMs) / durationMs;
        // An item unloaded mid-fade has nothing left to fade; give back its clones.
        if (level >= 1 || !object.parent) {
          settle(object, fade);
        } else {
          for (const dissolve of fade.dissolves) dissolve.setLevel(level);
        }
      }
    },
  };
}
