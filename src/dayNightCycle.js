// Shared day-night cycle (docs/SPEC.md §1: "shared, compressed 4-hour
// cycle (1 hour each: daylight, dusk, night, dawn) — not real-world-
// time-per-user. Ensures every time zone sees the full lighting range
// multiple times per real day."). Pure, dependency-free math — no
// THREE.js, no DOM — driven directly by a real timestamp (Date.now() in
// practice) rather than any per-session clock or server round-trip. That
// direct dependence on wall-clock time is what actually makes this
// "shared": every device computing this function at the same real moment
// gets the identical phase, with nothing to synchronize.
//
// The 4-hour figure itself is just today's default value for the world's
// own configurable `dayCycleHours` setting (see docs/API.md's "World
// settings"), not a constant baked in here — cycleHours is always an
// explicit parameter.

const PHASE_NAMES = ['daylight', 'dusk', 'night', 'dawn'];

// Keyframes at the start of each phase, plus daylight repeated at t=1 so
// interpolation wraps smoothly back into itself rather than jumping.
// Colors are plain [r, g, b] 0-255 triples — no color-library dependency.
const KEYFRAMES = [
  { t: 0, skyColor: [135, 206, 235], sunColor: [255, 255, 255], sunIntensity: 1.2, ambientColor: [255, 255, 255], ambientIntensity: 0.6 }, // daylight
  { t: 0.25, skyColor: [255, 140, 90], sunColor: [255, 171, 102], sunIntensity: 0.7, ambientColor: [255, 200, 170], ambientIntensity: 0.45 }, // dusk
  { t: 0.5, skyColor: [10, 16, 48], sunColor: [74, 90, 138], sunIntensity: 0.12, ambientColor: [60, 70, 110], ambientIntensity: 0.22 }, // night
  { t: 0.75, skyColor: [242, 182, 198], sunColor: [255, 207, 160], sunIntensity: 0.6, ambientColor: [255, 220, 200], ambientIntensity: 0.4 }, // dawn
  { t: 1, skyColor: [135, 206, 235], sunColor: [255, 255, 255], sunIntensity: 1.2, ambientColor: [255, 255, 255], ambientIntensity: 0.6 }, // daylight (wraps)
];

function lerp(a, b, f) {
  return a + (b - a) * f;
}

function lerpColor(a, b, f) {
  return [Math.round(lerp(a[0], b[0], f)), Math.round(lerp(a[1], b[1], f)), Math.round(lerp(a[2], b[2], f))];
}

function colorToHex([r, g, b]) {
  return (r << 16) | (g << 8) | b;
}

// Which of the four named phases a given cycle-progress fraction (0-1)
// falls in — each phase is exactly a quarter of the cycle, per the spec's
// own "1 hour each" (of a 4-hour cycle).
export function phaseNameAt(t) {
  const index = Math.min(PHASE_NAMES.length - 1, Math.floor(t * PHASE_NAMES.length));
  return PHASE_NAMES[index];
}

// nowMs: a real timestamp, typically Date.now(). cycleHours: the world's
// configured cycle length. Returns the current phase name/progress plus
// already-interpolated colors (as 0xRRGGBB integers, ready for
// THREE.Color.setHex) and intensities — everything a caller needs to
// paint a scene, with no further color math required on its end.
export function getDayNightState(nowMs, cycleHours) {
  const cycleMs = cycleHours * 60 * 60 * 1000;
  // The extra +cycleMs / %cycleMs keeps this correct for a negative
  // nowMs too (not a real scenario with Date.now(), but avoids a
  // negative-array-index footgun for any other caller, e.g. a test).
  const t = (((nowMs % cycleMs) + cycleMs) % cycleMs) / cycleMs;

  let lower = KEYFRAMES[0];
  let upper = KEYFRAMES[KEYFRAMES.length - 1];
  for (let i = 0; i < KEYFRAMES.length - 1; i += 1) {
    if (t >= KEYFRAMES[i].t && t <= KEYFRAMES[i + 1].t) {
      lower = KEYFRAMES[i];
      upper = KEYFRAMES[i + 1];
      break;
    }
  }
  const span = upper.t - lower.t;
  const f = span === 0 ? 0 : (t - lower.t) / span;

  return {
    phase: phaseNameAt(t),
    t,
    skyColorHex: colorToHex(lerpColor(lower.skyColor, upper.skyColor, f)),
    sunColorHex: colorToHex(lerpColor(lower.sunColor, upper.sunColor, f)),
    sunIntensity: lerp(lower.sunIntensity, upper.sunIntensity, f),
    ambientColorHex: colorToHex(lerpColor(lower.ambientColor, upper.ambientColor, f)),
    ambientIntensity: lerp(lower.ambientIntensity, upper.ambientIntensity, f),
  };
}
