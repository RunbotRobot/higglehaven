// #4331: the one definition of whether a new level fits under a builder's lándlet cap, read by the Worker (which
// refuses a level over it) and by the Build client (which says so before sending anything). A copy of each number
// on both sides could drift, and a person would then be told "no" by one and "yes" by the other.
//
// A builder comparing two numbers the UI shows rounded to a whole m² should not get a different answer than those
// rounded numbers imply, so the cap is allowed this much slack (see worker/lib/land-cap.js).
export const LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2 = 1;

// How many m² are left under the cap for a new level to take (never below zero).
export function landCapRoomM2(ownedAreaM2, capM2) {
  return Math.max(0, capM2 + LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2 - ownedAreaM2);
}

// Whether a level costing `capConsumedM2` fits under `capM2` when `ownedAreaM2` is already held.
export function levelFitsCap(ownedAreaM2, capConsumedM2, capM2) {
  return ownedAreaM2 + capConsumedM2 <= capM2 + LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2;
}
