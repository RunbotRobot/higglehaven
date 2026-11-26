// #4483 (part of #3396, "Moving, looking and drawing never wait on loading"): a unit of world work that has
// to do a lot of plain synchronous work (building a batch of thousands of placements) does it in slices and
// gives the frame back between them. The caller works in small chunks and asks `yieldIfSpent()` after each:
// once the slice has used its few milliseconds the call waits for the next animation frame and starts a
// fresh slice; before that it returns at once. Pure apart from the injected clock and frame scheduler, so it
// runs in the plain vitest pool.

const DEFAULT_SLICE_MS = 3; // under the 4 ms a frame gives world content (frameBudgetQueue.js): the unit that awaits this runs inside it

export function createSliceBudget({
  sliceMs = DEFAULT_SLICE_MS,
  now = () => performance.now(),
  nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
} = {}) {
  let sliceStart = now();
  let slices = 0;
  let longestSliceMs = 0;
  return {
    // Resolves true when it waited for a new frame (the caller should re-check anything that may have
    // changed meanwhile, such as a superseded load), false when the slice still has time.
    async yieldIfSpent() {
      const spent = now() - sliceStart;
      if (spent < sliceMs) return false;
      slices += 1;
      if (spent > longestSliceMs) longestSliceMs = spent;
      await nextFrame();
      sliceStart = now();
      return true;
    },
    // Call after an await that is not a frame hand-back (a download): the time spent waiting is not work.
    restart() {
      sliceStart = now();
    },
    // For the e2e read-out: how many frames the work took and the longest single slice (ms).
    stats() {
      const open = now() - sliceStart;
      return { slices: slices + 1, longestSliceMs: Math.max(longestSliceMs, open) };
    },
  };
}
