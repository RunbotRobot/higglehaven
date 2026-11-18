// #3736 (part of #3735): named performance marks for the stages of opening the
// app, so a slow open can be read off one report instead of re-measured by hand.
// Each mark is the time since navigation start, in whole milliseconds, kept once
// (the first call for a name wins) so a later mode switch cannot overwrite the
// first open. Never throws and never waits on anything: a browser without the
// Performance API just records nothing.
const PREFIX = 'hh:';
const seen = new Set();

export function markStartup(name) {
  if (seen.has(name)) return;
  seen.add(name);
  try {
    performance.mark(PREFIX + name);
  } catch { /* no Performance API: nothing to record */ }
}

// { stageName: ms since navigation start }, in the order the stages happened.
export function getStartupTimings() {
  try {
    return Object.fromEntries(
      performance.getEntriesByType('mark')
        .filter((m) => m.name.startsWith(PREFIX))
        .map((m) => [m.name.slice(PREFIX.length), Math.round(m.startTime)]),
    );
  } catch {
    return {};
  }
}
