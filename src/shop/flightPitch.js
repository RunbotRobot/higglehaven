// #3769: while flying, the avatar goes where the view points. There are no up
// and down buttons: looking up and moving forward climbs, looking down and
// moving forward descends, a level view flies level, moving back reverses it,
// and with no move gesture the avatar holds its height.
//
// Pure maths, kept out of flightMovement.js so it can be unit-tested.

const DEG = Math.PI / 180;

// Comfort figures (owner asked for them to be reported on the PR).
// A view within 4 degrees of level flies level: a thumb resting on the look
// side never drifts the avatar up or down.
export const FLIGHT_PITCH_DEADZONE_RAD = 4 * DEG;
// Full climb or descent speed is reached at 30 degrees, not at the sky: you
// can gain height with the horizon still in view.
export const FLIGHT_PITCH_FULL_RAD = 30 * DEG;
// How far the body tips with the view, either side of the usual forward lean
// (the limit on this keeps the avatar-inside-the-dome reach in flightMovement.js true).
export const FLIGHT_BODY_TILT_RANGE_RAD = 15 * DEG;

const smooth = (t) => t * t * (3 - 2 * t);

// -1..1: how much of the full vertical speed a view pitch (radians, positive
// is up) asks for. Zero inside the dead zone, then an eased ramp to full.
export function climbFactor(viewPitchRad) {
  const a = Math.abs(viewPitchRad);
  if (a <= FLIGHT_PITCH_DEADZONE_RAD) return 0;
  const t = Math.min(1, (a - FLIGHT_PITCH_DEADZONE_RAD) / (FLIGHT_PITCH_FULL_RAD - FLIGHT_PITCH_DEADZONE_RAD));
  return Math.sign(viewPitchRad) * smooth(t);
}

// The steepest the avatar climbs or dives along its path, reached at full
// climb factor. The view never has to point at the sky for this; and since
// the path is steep rather than vertical, the avatar still goes forward as it
// climbs, in step with where the view points.
export const FLIGHT_MAX_PATH_ANGLE_RAD = 50 * DEG;

// The angle of the avatar's path (radians, positive is up) for a view pitch.
export function pathAngleRad(viewPitchRad) {
  return climbFactor(viewPitchRad) * FLIGHT_MAX_PATH_ANGLE_RAD;
}

// Metres per second up (positive) or down. forwardInput is -1..1, positive
// forward; flightSpeedM_S is the same flight speed the horizontal move uses
// at full deflection, so the path keeps the speed it would have level.
export function verticalRateM_S(viewPitchRad, forwardInput, flightSpeedM_S) {
  const f = Math.max(-1, Math.min(1, forwardInput));
  return Math.sin(pathAngleRad(viewPitchRad)) * f * flightSpeedM_S;
}

// 0..1: how much of the level forward speed is left horizontally while the
// path climbs or dives (cos of the path angle), so speed along the path stays
// the same. Applies to the forward part of the move only; strafing keeps all of it.
export function horizontalForwardScale(viewPitchRad) {
  return Math.cos(pathAngleRad(viewPitchRad));
}

// Extra body tilt (radians, added to the usual flight lean, which is negative):
// nose up when looking up, nose down when looking down, within a small range.
export function bodyTiltOffsetRad(viewPitchRad) {
  return Math.max(-FLIGHT_BODY_TILT_RANGE_RAD, Math.min(FLIGHT_BODY_TILT_RANGE_RAD, viewPitchRad * 0.5));
}
