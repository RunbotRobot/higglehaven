// #4602 (Shipping 5/8, part of #4394): "Dim what cannot ship to me". Which country a shopper is judged by, and whether
// a physical product ships there. Imports nothing from the browser so it runs in the unit-test pool. The server holds
// the country and the switch (GET /api/shipping-destination); this only keeps what it said and applies it to a template.
import { shipsToCountry } from '../../shared/shipping-zones.js';

let destination = { country: null, dimUnshippable: false };
let loaded = false;
let loading = null;
const listeners = new Set();

export function currentShippingDestination() {
  return destination;
}

export function onShippingDestinationChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setShippingDestination(next) {
  destination = { country: next?.country || null, dimUnshippable: next?.dimUnshippable === true };
  loaded = true;
  for (const listener of listeners) listener(destination);
}

// Digital goods are never judged: an avatar or an animation has nothing to ship, and a product with a digital-goods
// notice is one too.
function isPhysical(template) {
  if (!template) return false;
  if (template.category === 'avatar' || template.category === 'animation') return false;
  return !template.metadata?.digitalGoodDisclaimer;
}

// True when the switch is on, the shopper has a destination, and this physical product does not ship there.
export function doesNotShipToMe(template, dest = destination) {
  if (!dest.dimUnshippable || !dest.country) return false;
  if (!isPhysical(template)) return false;
  return !shipsToCountry(template.metadata, dest.country);
}

// Read once per page; a failed read leaves nothing dimmed rather than a guess.
export function loadShippingDestination(fetchDestination, { force = false } = {}) {
  if (loaded && !force) return Promise.resolve();
  if (!loading) {
    loading = Promise.resolve()
      .then(fetchDestination)
      .then((result) => { if (result?.destination) setShippingDestination(result.destination); })
      .catch(() => {})
      .finally(() => { loading = null; });
  }
  return loading;
}
