// #3824 (found by the accessibility pass, #3818): a product can only be chosen by tapping it in
// the 3D world, so someone who cannot tap could not shop. Pressing N steps through the products
// around the shopper, nearest first, and opens each one's card (the same card a tap opens), with
// its name announced; Shift+N steps back. Pure ordering lives here, so it can be unit-tested; the
// key wiring is in flightMovement.js and the card and announcement in productCard.js.
//
// Two ways in, neither standing on the world: the N key, and a "Nearby" leaf under Shop's own petal
// (src/shop/nearbyLeaf.js, for a screen reader on a phone, where there is no key): the same ordering
// and the same card. The general menu is not touched (a Shop-only row there would change it under a
// person), and nothing is drawn until the leaf is opened. Tapping stays the way for everyone who can.

// How many of the nearest products the key cycles through: enough to reach what is around, few
// enough that a full turn is quick.
export const NEARBY_LIMIT = 8;

// The products nearest first (ties keep their loaded order), at most `limit` of them.
// `distanceOf(item)` is the metres from the shopper; an item with no finite distance is left out.
export function nearestProducts(items, distanceOf, limit = NEARBY_LIMIT) {
  return items
    .map((item, index) => ({ item, index, distance: distanceOf(item) }))
    .filter((entry) => Number.isFinite(entry.distance))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

// The product a press of N lands on: the one after `current` in the nearest-first list (before it
// with direction -1), wrapping round; with no card open (or one no longer in the list), the nearest
// (the furthest of the list for a backwards first press). Returns { item, position, total }, or
// null when nothing is near.
export function stepNearby(list, current, direction = 1) {
  if (!list.length) return null;
  const at = current ? list.indexOf(current) : -1;
  let position;
  if (at === -1) position = direction < 0 ? list.length - 1 : 0;
  else position = (at + (direction < 0 ? -1 : 1) + list.length) % list.length;
  return { item: list[position], position: position + 1, total: list.length };
}

// What a screen reader is told: the product's name and where it stands in the list. A single
// product is just its name.
export function nearbyAnnouncement(name, position, total) {
  if (!name) return 'Product';
  return total > 1 ? `${name}, ${position} of ${total} nearby` : name;
}

export const NO_NEARBY_PRODUCTS = 'No products nearby';

// What the Nearby leaf says when nothing is within reach.
export const NEARBY_LEAF_EMPTY = 'No products within reach. Walk closer to a lándlet to see what is near.';

// How far a product is, in words a row can carry: whole metres, "Here" under one.
export function distanceWords(metres) {
  if (!Number.isFinite(metres)) return '';
  const whole = Math.round(metres);
  return whole < 1 ? 'Here' : `${whole} m`;
}

// #4044 (part of #3539): which way a product is, in words, from where the shopper is looking. `forward`
// and `to` are horizontal world vectors ({x, y}, Z-up): the way the camera faces, and the way to the
// product. Positive is to the left (the world is turned counter-clockwise by a positive yaw). Plain words,
// no compass and no degrees: "ahead", "ahead and to the left", "to the right", "behind and to the left".
export function directionWords(forward, to) {
  const angle = Math.atan2(forward.x * to.y - forward.y * to.x, forward.x * to.x + forward.y * to.y);
  const deg = Math.abs(angle) * (180 / Math.PI);
  if (!Number.isFinite(deg)) return '';
  const side = angle > 0 ? 'left' : 'right';
  if (deg < 25) return 'ahead';
  if (deg < 70) return `ahead and to the ${side}`;
  if (deg < 110) return `to the ${side}`;
  if (deg < 155) return `behind and to the ${side}`;
  return 'behind';
}

// The yaw that faces the world point (dx, dy) away from the shopper: yaw 0 faces +Y and a positive yaw
// turns counter-clockwise, so forward is (-sin yaw, cos yaw). Used to turn the view toward a product.
export function yawFacing(dx, dy) {
  return Math.atan2(-dx, dy);
}
