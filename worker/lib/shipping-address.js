// #4599 (shipping, 2/8; owner decision 2026-11-27, option B): a physical product is bought with an address to send it
// to, and the order keeps its own copy of that address.
//
// The address is personal data of a new kind. It is read by the person it belongs to (My purchases) and, in a later
// piece, by the seller of that one order; nothing else reads it (no search, no analytics, no self-dealing signal). The
// server decides everything: whether a product is shipped, whether the address is complete, and whether the seller sends
// to that country. The client only shows.
import { HttpError, ERROR_CODES } from './http.js';
import { isKnownCountryCode } from './country-codes.js';
import { COUNTRY_CODES, shippingZonesOf, shippingZoneOfCountry, shipsToCountry, shippingPlaces, shippingNote, SHIPPING_ZONE_IDS } from '../../shared/shipping-zones.js';

// Stripe keeps one metadata value to 500 characters, and the card path carries this address there from checkout to
// finalize, so every field has a cap that keeps the whole JSON well under it (about 360 characters at the caps).
export const SHIPPING_ADDRESS_LIMITS = Object.freeze({ name: 60, line1: 80, line2: 60, city: 40, region: 40, postalCode: 20 });

const FIELD_LABELS = Object.freeze({
  name: 'the name to send it to',
  line1: 'the street address',
  line2: 'the second address line',
  city: 'the city',
  region: 'the state or region',
  postalCode: 'the postal code',
  country: 'the country',
});

// A product is shipped unless it is a digital good: the seller marked it one (the disclaimer), or it is an avatar or an
// animation, which are granted to the buyer's owned list with nothing to send.
export function requiresShippingAddress(template) {
  let metadata = {};
  try { metadata = JSON.parse(template.metadata_json || '{}'); } catch { metadata = {}; }
  if (metadata.digitalGoodDisclaimer) return false;
  return template.category !== 'avatar' && template.category !== 'animation';
}

// The shipping facts of a template (metadata.shippingZones, or the old flag for a product not yet migrated), read by the
// one set of functions in shared/shipping-zones.js that the client also uses (#4631: this used to look at the old flag
// alone, so a product limited to some zones was not stopped at purchase).
function templateMetadata(template) {
  try { return JSON.parse(template.metadata_json || '{}'); } catch { return {}; }
}

// The country codes a shipped product goes to, or null when it goes everywhere (so the client has nothing to restrict).
export function shippingCountriesOf(template) {
  const metadata = templateMetadata(template);
  const zones = shippingZonesOf(metadata);
  if (zones.length === SHIPPING_ZONE_IDS.length) return null;
  return COUNTRY_CODES.filter((code) => zones.includes(shippingZoneOfCountry(code)));
}

// Plain words for where a product goes, for the buyer's form ("United States only", "United States and Canada").
export function shippingPlacesOf(template) {
  return shippingPlaces(templateMetadata(template));
}

function clean(value) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function invalid(message) {
  return new HttpError(`${message} You were not charged.`, 400, { code: ERROR_CODES.SHIPPING_ADDRESS_INVALID });
}

// The cleaned address, or an HttpError that says in plain words what is wrong with it.
export function parseShippingAddress(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError('This product is shipped, so it needs an address to send it to. You were not charged.', 400, { code: ERROR_CODES.SHIPPING_ADDRESS_REQUIRED });
  }
  const address = {};
  for (const field of ['name', 'line1', 'line2', 'city', 'region', 'postalCode']) {
    const value = clean(input[field]);
    if (value.length > SHIPPING_ADDRESS_LIMITS[field]) {
      throw invalid(`Shorten ${FIELD_LABELS[field]} to ${SHIPPING_ADDRESS_LIMITS[field]} characters or fewer.`);
    }
    address[field] = value;
  }
  address.country = clean(input.country).toUpperCase();
  for (const field of ['name', 'line1', 'city', 'postalCode', 'country']) {
    if (!address[field]) throw invalid(`Add ${FIELD_LABELS[field]}.`);
  }
  if (!isKnownCountryCode(address.country)) throw invalid('Choose the country from the list.');
  // A US address always has a state, and the seller needs it to find the right post office.
  if (address.country === 'US' && !address.region) throw invalid(`Add ${FIELD_LABELS.region}.`);
  return address;
}

// What a purchase of this product needs from the request, before any card is touched: the cleaned address (null for a
// product that is not shipped), or a refusal.
export function shippingAddressForPurchase(template, input) {
  if (!requiresShippingAddress(template)) return null;
  const address = parseShippingAddress(input?.shippingAddress);
  const metadata = templateMetadata(template);
  if (!shipsToCountry(metadata, address.country)) {
    throw new HttpError(`This product ${shippingNote(metadata)}, so it cannot be sent to that country. You were not charged.`, 409, { code: ERROR_CODES.NOT_SHIPPABLE_THERE });
  }
  return address;
}

// A stored snapshot, read back for display: the object, or null when the order has none (a digital good, or an order
// made before addresses were asked for).
export function shippingAddressFromRow(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// #4636: an order keeps its address copy only while the address can still do a job: to ship the parcel, and to answer a
// "not received" dispute about it. The in-app dispute closes at payout (7 days after shipping) but a card dispute does
// not: the buyer's bank can open one for roughly 120 days, and what answers it is the address, carrier and tracking
// number (Stripe's dispute evidence fields). So the copy is kept for one term after the order ships, sized to that window
// plus time to respond, whether or not the sale has been paid out, and cleared at once for an order refunded by the
// seller or buyer (nothing left to dispute). A dispute withdrawal also marks the order refunded (stripe.js), but the
// card dispute is then still being answered with this very address, so an order that has had a dispute event
// (last_dispute_event_at) keeps it for the term like any other.
// The order, its price and its tracking stay; only the address goes. (higglehaven1's rule, #4636.)
export const ADDRESS_KEPT_AFTER_SHIPPING_DAYS = 180;

// One statement, safe to run every ten minutes and to run twice: it only ever clears.
export async function clearSettledOrderAddresses(db, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - ADDRESS_KEPT_AFTER_SHIPPING_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    UPDATE purchases SET shipping_address_json = NULL
    WHERE shipping_address_json IS NOT NULL
      AND ((refunded_at IS NOT NULL AND last_dispute_event_at IS NULL) OR (shipped_at IS NOT NULL AND shipped_at < ?))
  `).bind(cutoff).run();
  return result.meta?.changes ?? 0;
}
