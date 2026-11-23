// #4044 (part of #3539): a way for a leaf to turn the shopper's view toward a point in the world without
// importing the movement core (which imports the leaf). flightMovement.js registers the turner; the
// Nearby leaf asks. It only ever turns: it never moves the avatar for the person.
let turner = null;
export function registerViewTurner(fn) { turner = fn; }
// Turns the avatar and the camera to face the world point (x, y). Returns false when nothing is registered.
export function turnViewToward(x, y) {
  if (!turner) return false;
  turner(x, y);
  return true;
}
