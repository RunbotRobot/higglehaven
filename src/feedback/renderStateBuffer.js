// #2717 (leaf of #2715's "[Tracking] In-app 'Submit Feedback' bug reports
// with automatic rendering-state capture"): a client-side, in-memory
// rolling buffer of render state -- position/orientation plus relevant
// shader uniforms, sampled at ~1Hz over a ~60s window, discarded unless a
// report is ever actually submitted.
//
// Exists so a future "Submit Feedback" click (#2718, the UI sub-issue; the
// payload then ships to the Worker endpoint added by #2719) can hand over
// what the scene looked like for the *preceding* ~60 seconds, not just the
// instant of the click -- the exact gap #2715's own body describes hitting
// repeatedly while diagnosing the Shop-mode sky artifacts (PR #2606/#2617
// and #2716's still-open follow-up): by the time a report reaches a
// session, the one thing that actually mattered -- exact render state at
// the moment the artifact appeared -- is long gone, because that class of
// artifact (#2716 is the concrete example) unfolds over the preceding tens
// of seconds, not at the single instant a user happens to click a button.
//
// Deliberately dependency-free (no three.js/DOM/network imports), unlike
// every shop/*.js leaf this is meant to eventually feed from -- that keeps
// it in the plain src/**/*.test.js vitest pool (which runs under workerd,
// not a browser) rather than needing e2e/Playwright coverage the way
// shop/sky.js's own shader work does. recordRenderStateSample takes a
// plain snapshot object rather than reading the camera/scene itself, so
// whichever per-frame loop wires this in (Shop mode's own
// registerModeFrameUpdate callback -- the same place updateShopSky already
// runs -- is the obvious first caller) owns every three.js/DOM read, and
// this module only ever stores/trims/returns plain data.
//
// #2715's own field list ("camera/avatar position + orientation, relevant
// shader uniforms (e.g. uTime, world radius, shop id), frame timestamp")
// is deliberately NOT enforced here as a fixed shape -- this module has no
// opinion on what a snapshot contains, just how long it's kept and how
// often. (One field from that list, "shop id", has no real counterpart to
// capture yet: GET /api/world is a singleton -- see docs/API.md's own "GET
// /api/world" section, "Fetches the singleton world settings object" --
// there is currently exactly one shop/world, not several identified by an
// id. Whichever caller wires this in passes whatever fields actually exist
// at the time.)

const SAMPLE_INTERVAL_MS = 1000; // ~1Hz, per #2715's own spec
const BUFFER_WINDOW_MS = 60000; // ~60s, per #2715's own spec

let samples = [];
let lastSampleAtMs = null;

// Called every frame (or as often as the caller likes -- e.g. once per
// rAF tick, same as updateShopSky) with the current clock reading (ms;
// callers already using a requestAnimationFrame timestamp, like Shop
// mode's own per-frame callback, should just pass that straight through --
// this only ever uses it as a relative clock for throttling/trimming, never
// as a wall-clock/epoch value) and a plain snapshot object describing
// render state right now. Throttles itself to ~1Hz internally
// (SAMPLE_INTERVAL_MS) so a caller never needs its own timing logic, and
// trims anything older than the ~60s window (BUFFER_WINDOW_MS) on every
// call so the buffer can never grow unbounded even if getRenderStateBuffer
// is never read.
export function recordRenderStateSample(nowMs, snapshot) {
  if (lastSampleAtMs !== null && nowMs - lastSampleAtMs < SAMPLE_INTERVAL_MS) return;
  lastSampleAtMs = nowMs;
  samples.push({ timestampMs: nowMs, ...snapshot });
  const cutoffMs = nowMs - BUFFER_WINDOW_MS;
  while (samples.length && samples[0].timestampMs < cutoffMs) samples.shift();
}

// The "simple 'give me the current buffer contents' accessor" #2715's own
// body asks for -- #2715's other sub-issues (the "Submit Feedback" UI,
// #2718) read from this rather than reaching into this module's private
// `samples` array directly. Returns a fresh copy, oldest sample first, so a
// caller mutating what it got back can never corrupt this module's own
// buffer.
export function getRenderStateBuffer() {
  return samples.map((sample) => ({ ...sample }));
}

// Clears the buffer outright and re-arms the ~1Hz throttle so the very next
// recordRenderStateSample call is always accepted regardless of timing --
// e.g. once a report has actually been submitted (#2715's own "discarded if
// never submitted" framing implies clearing it *is* meaningful once it has
// been) -- and for tests.
export function clearRenderStateBuffer() {
  samples = [];
  lastSampleAtMs = null;
}
