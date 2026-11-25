// #4298 (found in the #4277 audit of what a person sees when a request after start-up fails once): a
// background read that fed something on screen used to be asked exactly once with `.catch(() => {})`, so one
// network blip left the screen on its fallback for the rest of the session. This asks again after a short,
// growing wait, a few times at most, and then lets the caller's own error handling see the last failure.
// `sleep` is injectable so the wait is not real in a unit test.
export const DEFAULT_RETRY_DELAYS_MS = [2000, 8000];

export async function readWithRetry(read, {
  delaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isStale = () => false,
} = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await read();
    } catch (err) {
      if (attempt >= delaysMs.length || isStale()) throw err;
      await sleep(delaysMs[attempt]);
      attempt += 1;
      // The screen this read was for has gone (the mode was left, a newer read took over): stop asking.
      if (isStale()) throw err;
    }
  }
}

// #4317 (same audit): a count that feeds the head (the notices dot, the friend-request note) is refreshed by
// callers that wait for it, so a retry here must not hold them: when a refresh fails, it is run again in the
// background after the next wait of `delaysMs` (attempt 0 -> first wait), and gives up after the last one.
// Returns true when a retry was scheduled. `schedule` is injectable so a unit test needs no real timer.
export function scheduleRetry(runAgain, attempt, {
  delaysMs = DEFAULT_RETRY_DELAYS_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  const wait = delaysMs[attempt];
  if (wait === undefined) return false;
  schedule(() => { runAgain(attempt + 1); }, wait);
  return true;
}
