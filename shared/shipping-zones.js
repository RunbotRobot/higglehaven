// #4601 (part of #4394, shipping): the one definition of where a physical product can be shipped, read by the
// Worker (which refuses anything else) and by the client (Sell's shipping choice, the card's shipping note). A fixed list
// of destination zones, and every country code mapped to exactly one of them. Today a product has one flag,
// `metadata.domesticOnly`; `shippingZones` replaces it, and `shippingZonesOf` reads a product that still has the
// old flag as what it always meant, so nothing changes for it until its seller edits shipping.
//
// The split is ordinary engineering, not an owner call: the places a small seller's carrier rates and rules differ
// (the United States itself, its two neighbours, the United Kingdom, the European Union, Australia and New Zealand,
// Japan and South Korea) and everywhere else. A territory (Puerto Rico, Guam) is not the United States zone: it
// is in "everywhere else", as it is for most carriers' zone tables, and a seller who ships there says so.

export const SHIPPING_ZONES = [
  { id: 'us', label: 'United States' },
  { id: 'ca', label: 'Canada' },
  { id: 'mx', label: 'Mexico' },
  { id: 'gb', label: 'United Kingdom' },
  { id: 'eu', label: 'European Union' },
  { id: 'anz', label: 'Australia and New Zealand' },
  { id: 'jpkr', label: 'Japan and South Korea' },
  { id: 'rest', label: 'Everywhere else' },
];
export const SHIPPING_ZONE_IDS = SHIPPING_ZONES.map((zone) => zone.id);
export const HOME_SHIPPING_ZONE_ID = 'us';

// Every officially assigned ISO 3166-1 alpha-2 code (249).
export const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
  + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT '
  + 'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ '
  + 'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const ZONE_OF_NAMED_COUNTRY = new Map([
  ['US', 'us'], ['CA', 'ca'], ['MX', 'mx'], ['GB', 'gb'],
  ['AU', 'anz'], ['NZ', 'anz'], ['JP', 'jpkr'], ['KR', 'jpkr'],
  ...'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ').map((code) => [code, 'eu']),
]);

// The zone a destination country is in, or null for something that is not a country code.
export function shippingZoneOfCountry(countryCode) {
  if (typeof countryCode !== 'string') return null;
  const code = countryCode.trim().toUpperCase();
  if (!COUNTRY_CODES.includes(code)) return null;
  return ZONE_OF_NAMED_COUNTRY.get(code) ?? 'rest';
}

export function isShippingZoneId(id) {
  return SHIPPING_ZONE_IDS.includes(id);
}

// The zones a product ships to, from its metadata, in the list's order. `shippingZones` when it has one; a
// product that still carries the old flag keeps what the flag meant (`domesticOnly` true is the United States only;
// absent or false is everywhere, which is what a product without the flag has always done).
export function shippingZonesOf(metadata) {
  if (Array.isArray(metadata?.shippingZones)) {
    return SHIPPING_ZONE_IDS.filter((id) => metadata.shippingZones.includes(id));
  }
  if (metadata?.domesticOnly === true) return [HOME_SHIPPING_ZONE_ID];
  return [...SHIPPING_ZONE_IDS];
}

export function shipsToCountry(metadata, countryCode) {
  const zone = shippingZoneOfCountry(countryCode);
  return zone !== null && shippingZonesOf(metadata).includes(zone);
}

// The Worker's check on what a seller sends: an array of known zone ids, no repeats, at least one.
// Returns the problem as a sentence, or null when the value is fine.
export function shippingZonesProblem(value) {
  if (!Array.isArray(value)) return 'metadata.shippingZones must be a list of zone ids';
  if (value.length === 0) return 'metadata.shippingZones must name at least one zone';
  if (!value.every(isShippingZoneId)) return `metadata.shippingZones may only hold: ${SHIPPING_ZONE_IDS.join(', ')}`;
  if (new Set(value).size !== value.length) return 'metadata.shippingZones must not repeat a zone';
  return null;
}

// The words on the product's card, derived from the zones and never stored.
export function shippingNote(metadata) {
  const zones = shippingZonesOf(metadata);
  if (zones.length === SHIPPING_ZONE_IDS.length) return 'ships worldwide';
  const labels = zones.map((id) => SHIPPING_ZONES.find((zone) => zone.id === id).label);
  if (labels.length === 0) return 'does not ship';
  if (labels.length === 1) return `ships to ${labels[0]} only`;
  return `ships to ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
