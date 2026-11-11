// #3396: how long did the screen go without drawing a frame, and did the main
// thread block. "Moving, looking and drawing never wait on loading" is only a
// rule if it is measured, so every frame's gap is recorded here and the long
// stalls the browser itself reports (the Long Tasks API, any task over 50 ms)
// are counted. The numbers are exposed to e2e (window.__frameMonitor) and sent
// with a Submit Feedback report (frameMonitorSample, below).
//
// Dependency-free apart from the optional PerformanceObserver, with the clock
// passed in, so it runs in the plain vitest pool.

const NOTABLE_GAP_MS = 50; // a frame gap at or above this is worth remembering for the diagnostic window
const RECENT_WINDOW_MS = 1000; // what "recent" means for the feedback sample (it is sampled at ~1 Hz)
const BACKGROUND_GAP_MS = 5000; // a longer gap is a backgrounded tab, not a stall

let lastFrameAtMs = null;
let longestGapMs = 0; // since the last reset
let recentGaps = []; // [{ atMs, gapMs }], notable gaps in the last RECENT_WINDOW_MS
let longTaskCount = 0; // cumulative since page load
let longestLongTaskMs = 0;
// added for #3483 -- a 2.7 s long task that appears once, on the first visit
// after a deploy; the report only had its size, so nobody could tell a slow
// title screen from a freeze in flight. When the longest one started
// (ms since navigation), so a live-site report can say which step it fell in.
let longestLongTaskAtMs = null;

// Called once per rendered frame with the frame's timestamp (ms).
export function recordFrame(nowMs) {
  if (lastFrameAtMs !== null) {
    const gap = nowMs - lastFrameAtMs;
    if (gap < BACKGROUND_GAP_MS) {
      if (gap > longestGapMs) longestGapMs = gap;
      if (gap >= NOTABLE_GAP_MS) recentGaps.push({ atMs: nowMs, gapMs: gap });
    }
  }
  lastFrameAtMs = nowMs;
  if (recentGaps.length && nowMs - recentGaps[0].atMs > RECENT_WINDOW_MS) {
    recentGaps = recentGaps.filter((entry) => nowMs - entry.atMs <= RECENT_WINDOW_MS);
  }
}

// The frame before a tab was hidden and the one after it are not neighbours.
export function noteFramesPaused() {
  lastFrameAtMs = null;
}

export function recordLongTask(durationMs, startMs = null) {
  longTaskCount += 1;
  if (durationMs > longestLongTaskMs) {
    longestLongTaskMs = durationMs;
    longestLongTaskAtMs = startMs;
  }
}

// Longest gap between two frames since the last reset (ms), for e2e.
export function longestFrameGapMs() {
  return longestGapMs;
}

export function longTasks() {
  return { count: longTaskCount, longestMs: longestLongTaskMs, longestAtMs: longestLongTaskAtMs === null ? null : Math.round(longestLongTaskAtMs) };
}

export function resetFrameMonitor() {
  longestGapMs = 0;
  recentGaps = [];
  longTaskCount = 0;
  longestLongTaskMs = 0;
  longestLongTaskAtMs = null;
}

// The two figures a bug report carries: the longest gap between frames in the
// last second (0 when every recent frame was on time) and the long-task count.
export function frameMonitorSample(nowMs) {
  let recentLongest = 0;
  for (const entry of recentGaps) {
    if (nowMs - entry.atMs <= RECENT_WINDOW_MS && entry.gapMs > recentLongest) recentLongest = entry.gapMs;
  }
  return { longestFrameMs: Math.round(recentLongest), longTaskCount };
}

// Browser wiring: count long tasks, pause across a hidden tab, and expose the
// numbers to e2e. Safe to call where PerformanceObserver or the longtask entry
// type does not exist (it then counts nothing).
export function startFrameMonitor(target = globalThis) {
  try {
    const observer = new target.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordLongTask(entry.duration, entry.startTime);
    });
    observer.observe({ type: 'longtask' });
  } catch {
    // unsupported: the frame-gap figures still work
  }
  target.document?.addEventListener('visibilitychange', noteFramesPaused);
  target.__frameMonitor = {
    reset: resetFrameMonitor,
    longestFrameGapMs,
    longTasks,
  };
}
