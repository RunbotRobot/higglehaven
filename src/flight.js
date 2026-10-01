// Pure Shop-mode flight math, extracted out of src/main.js the same way
// settings.js already is — no three.js/DOM dependency, so this is directly
// unit-testable in the workerd test pool (see vitest.config.js's own note
// on why three.js-importing code can't live there).

// Mirrors THREE.MathUtils.smoothstep(x, 0, 1) exactly (three.js's own
// implementation: clamp to [0, 1], then the classic 3x² - 2x³ ease).
export function smoothstep(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

// docs/SPEC.md §2's "~1s lift": a smoothstep-eased climb from the ground to
// hoverAltitudeM over durationS seconds. elapsedS past durationS holds at
// hoverAltitudeM rather than overshooting (the caller — updateShopFlight —
// is the one that actually transitions out of 'takingOff' once elapsed
// reaches durationS; this function just describes the ramp itself).
export function takeoffAltitudeM(elapsedS, durationS, hoverAltitudeM) {
  return smoothstep(elapsedS / durationS) * hoverAltitudeM;
}

// docs/SPEC.md §2's "~2s reverse": the exact inverse ramp, descending from
// startAltitudeM (wherever the player actually was when landing began, not
// always the same height) back to 0 over durationS seconds.
export function landingAltitudeM(elapsedS, durationS, startAltitudeM) {
  return startAltitudeM * (1 - smoothstep(elapsedS / durationS));
}

// #1090: landingAltitudeM above has no idea what's directly underneath —
// it just eases to 0 as a function of time, so a landing that started
// above a placed item carries straight through its solid geometry on the
// way down. updateShopFlight (src/main.js) is the one that actually knows
// about placed items (via shopLandingObstructionTopZ, which needs the real
// footprint/mesh data this file deliberately has no access to — see this
// module's own header comment); it supplies minAltitudeM as the floor nothing
// below should pass (0 when the ground itself is clear), and this function
// just owns the "does the ramp still have room to fall, or has it already
// hit something" arithmetic, the same way landingAltitudeM owns the ramp
// itself. Landing finishes the instant the ramp would go at or past that
// floor — whether that's because durationS has genuinely elapsed (the
// ordinary case, minAltitudeM 0) or because an obstruction stopped it early.
export function clampedLandingAltitudeM(elapsedS, durationS, startAltitudeM, minAltitudeM) {
  const rampAltitudeM = landingAltitudeM(elapsedS, durationS, startAltitudeM);
  if (rampAltitudeM <= minAltitudeM) return { altitudeM: minAltitudeM, landed: true };
  return { altitudeM: rampAltitudeM, landed: elapsedS >= durationS };
}

// docs/SPEC.md §2's altitude/speed curve: "each doubling of altitude ≈ 50%
// more max ground speed" fixes the curve's shape as a power law (speed ∝
// altitude^p) with p = log2(1.5) ≈ 0.585 — a whole doubling of the input
// giving exactly a 1.5x, not 2x, output is the definition of that exponent.
// Anchored at "~10x at building height" (refAltitudeM/refMultiplier) and
// clamped to the spec's own [1x, 100x] range — the low end purely so a
// pure power law (which diverges toward 0 as altitude approaches 0) never
// actually reaches 0 and strands the player mid-transition; the high end
// is the spec's own "~100x at max altitude" ceiling.
export function flightSpeedMultiplier(
  altitudeM,
  { refAltitudeM = 10, refMultiplier = 10, exponent = Math.log2(1.5), minMultiplier = 1, maxMultiplier = 100 } = {},
) {
  const raw = refMultiplier * Math.pow(Math.max(altitudeM, 0.01) / refAltitudeM, exponent);
  return Math.min(maxMultiplier, Math.max(minMultiplier, raw));
}
