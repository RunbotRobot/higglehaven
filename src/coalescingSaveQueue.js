// #1062: runs saves for the same key (an instance id) one at a time, in the
// order they were requested, and shares a save that is still waiting behind
// the one in flight among every later request. `send` is called only when a
// save actually starts, so it reads the newest state then; a burst of N
// requests costs at most two sends (the in-flight one plus one more) and the
// last send always reflects the latest state, which is what stops an older
// request landing after a newer one and silently reverting it.
//
// Dependency-free so it can be unit tested under the workerd pool.
export function createCoalescingSaveQueue(send) {
  const tails = new Map(); // key -> promise of the last queued save
  const waiting = new Map(); // key -> queued save that has not started yet
  return {
    // `onQueued` runs once per save actually queued (not per coalesced call).
    request(key, subject, onQueued) {
      const pending = waiting.get(key);
      if (pending) return pending;
      onQueued?.();
      const previous = tails.get(key) ?? Promise.resolve();
      const queued = previous.then(() => {
        waiting.delete(key);
        return send(subject);
      });
      waiting.set(key, queued);
      tails.set(key, queued);
      queued.then(() => {
        if (tails.get(key) === queued) tails.delete(key);
      }, () => {
        if (tails.get(key) === queued) tails.delete(key);
      });
      return queued;
    },
  };
}
