// #4599 (shipping, 2/8; owner decision 2026-11-27, option B): a physical product is bought with an address to send it
// to, and the order keeps its own copy of that address.
//
// The address is personal data of a new kind. It is read by the person it belongs to (My purchases) and, in a later
// piece, by the seller of that one order; nothing else reads it (no search, no analytics, no self-dealing signal). The
// server decides everything: whether a product is shipped, whether the address is complete, and whether the seller sends
// to that country. The client only shows.
import { HttpError, ERROR_CODES } from './http.js';
import { isKnownCountryCode } from './country-codes.js';

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

export function templateShipsDomesticOnly(template) {
  try { return JSON.parse(template.metadata_json || '{}').domesticOnly === true; } catch { return false; }
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
  if (templateShipsDomesticOnly(template) && address.country !== 'US') {
    throw new HttpError('The seller sends this product within the United States only, so it cannot be sent to that country. You were not charged.', 409, { code: ERROR_CODES.NOT_SHIPPABLE_THERE });
  }
  return address;
}

// A stored snapshot, read back for display: the object, or null when the order has none (a digital good, or an order
// made before addresses were asked for).
export function shippingAddressFromRow(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}
