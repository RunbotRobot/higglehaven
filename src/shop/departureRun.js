// #4391 (leaf 1): the leaving half of a version change. An item that is not in the new version fades out where it
// stands (the dither dissolve of arrivalEffect.js, run from opaque to nothing) over about 2.5 s, the spec's "old
// items fade" (docs/SPEC.md section 3), and is then handed back to be removed and disposed. It is out of the
// landlet's interactive lists from the moment it starts (the caller removes it), so only its picture is left.
import { createArrivalDissolve } from './arrivalEffect.js';

export const DEPARTURE_S = 2.5;
export const DEPARTURE_REDUCED_MOTION_S = 0.4;

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export function createDepartureRun({
  clock = () => performance.now(),
  reducedMotion = prefersReducedMotion(),
  createDissolve = createArrivalDissolve,
} = {}) {
  const items = []; // { dissolve, startMs, onGone }
  let disposed = false;
  let expected = 0; // items promised by expect() that have not been added (or given up) yet
  const durationS = reducedMotion ? DEPARTURE_REDUCED_MOTION_S : DEPARTURE_S;
  return {
    // `object` is fully drawn now; onGone(object) runs once it is invisible (or the run is disposed).
    // The caller sets items up one at a time over several frames: it says how many are coming, so the run is not
    // reported settled (and dropped) before they have all been added or given up.
    expect(count) {
      expected += count;
    },
    giveUp() {
      expected = Math.max(0, expected - 1);
    },
    add(object, onGone) {
      expected = Math.max(0, expected - 1);
      if (disposed) { onGone(object); return; }
      const dissolve = createDissolve(object);
      dissolve.setLevel(1);
      items.push({ object, dissolve, startMs: clock(), onGone });
    },
    update() {
      if (disposed || items.length === 0) return;
      const nowMs = clock();
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        const t = (nowMs - item.startMs) / 1000 / durationS;
        item.dissolve.setLevel(1 - smoothstep(t));
        if (t >= 1) {
          items.splice(i, 1);
          item.dissolve.restore();
          item.onGone(item.object);
        }
      }
    },
    settled() {
      return items.length === 0 && expected === 0;
    },
    count() {
      return items.length;
    },
    // Everything still leaving goes now (an unload): plain materials back, then removed by the caller.
    dispose() {
      if (disposed) return;
      disposed = true;
      expected = 0;
      for (const item of items.splice(0)) {
        item.dissolve.restore();
        item.onGone(item.object);
      }
    },
  };
}
