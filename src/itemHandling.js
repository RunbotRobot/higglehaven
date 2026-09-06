// Pure logic behind #216's item-handling animations (docs/SPEC.md §2:
// "Item-handling animations trigger on sustained view-attention (pick-up-
// and-turn for small items, walk-around for furniture-scale)"), built on
// #215's sustained-attention tracking. src/main.js applies the actual pose
// (arm-pivot rotations, avatar yaw) every frame using three.js objects,
// which can't run in this pool — see settings.js/flight.js/attention.js's
// own header comments for why this repo pulls that logic out into small,
// directly-testable modules like this one instead.

// Which animation a target's own size calls for — the spec's own two
// named cases, split at one configurable threshold rather than two
// separate size classes, since nothing in between needs a third pose.
export function classifyHandlingKind(maxDimensionM, smallMaxDimensionM) {
  return maxDimensionM <= smallMaxDimensionM ? 'pick-up-and-turn' : 'walk-around';
}

// Eases the handling pose in when it should be playing and back out when
// it shouldn't, the same ease-toward-target-per-second shape this repo's
// other blends already use (see e.g. updateShopAvatarIdle's own
// shopIdleBlend) rather than a hard on/off cut.
export function nextHandlingBlend(currentBlend, active, blendPerS, dt) {
  const target = active ? 1 : 0;
  return currentBlend + (target - currentBlend) * Math.min(1, blendPerS * dt);
}

// Advances a cycle's own phase in radians — periodS seconds is one full
// 2*PI revolution. Used both for pick-up-and-turn's back-and-forth
// Math.sin(phase) sway and walk-around's continuous phase-as-yaw spin.
export function nextPhase(currentPhase, periodS, dt) {
  return currentPhase + (dt / periodS) * Math.PI * 2;
}

// True the instant a playing handling animation should stop: real
// movement input or takeoff always wins immediately (the same hard-cut
// rule updateShopAvatarIdle's own comment already uses for ending idle),
// and a hard duration cap bounds any single play even if attention never
// wavers — not a "never loops" guarantee (sustained attention can
// legitimately retrigger a fresh play right after), just a bound on each
// individual one.
export function shouldEndItemHandling({ airborne, moveMagnitude, elapsedS, maxDurationS }) {
  return airborne || moveMagnitude > 0 || elapsedS >= maxDurationS;
}
