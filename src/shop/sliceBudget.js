// #4483 (part of #3396, "Moving, looking and drawing never wait on loading"): a unit of world work that has to do a
// lot of plain synchronous work (building a batch of thousands of placements) does it in slices, each its own unit of
// the world work queue, so the queue's other units (nearer items, other landlets, undo rebuilds, disposals) interleave
// between the slices instead of waiting for the whole job. A slice works in small chunks and asks `over()` after each:
// once it has used its few milliseconds (or what is left of the queue's tick, if that is less) it ends and the job
// queues its continuation. Every slice does at least one chunk, so a job always makes progress. Pure apart from the
// injected clock, so it runs in the plain vitest pool.

export const DEFAULT_SLICE_MS = 3; // a slice's own cap; the queue's per-tick budget (frameBudgetQueue.js, 4 ms) can make it smaller

export function startSlice({ capMs = DEFAULT_SLICE_MS, remainingMs = capMs, now = () => performance.now() } = {}) {
  const start = now();
  const allowedMs = Math.min(capMs, Math.max(0, remainingMs));
  return {
    allowedMs,
    elapsedMs: () => now() - start,
    over: () => now() - start >= allowedMs,
  };
}
