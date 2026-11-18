// #3824 (found by the accessibility pass, #3818): a product can only be chosen by tapping it in
// the 3D world, so someone who cannot tap could not shop. Pressing N steps through the products
// around the shopper, nearest first, and opens each one's card (the same card a tap opens), with
// its name announced; Shift+N steps back. Pure ordering lives here, so it can be unit-tested; the
// key wiring is in flightMovement.js and the card and announcement in productCard.js.
//
// Why a key and not a "Nearby" leaf in the bud menu: the menu is the same in every mode (a Shop-only
// row would change it under a person), and a list over the world is exactly the permanent control
// the interface is trying not to be. Tapping stays the way for everyone who can; N is the way when
// they cannot. When Shop gets its own submenu under its petal, a Nearby list can join it there
// (the same function orders it).

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
