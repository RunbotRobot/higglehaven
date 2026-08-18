// Local display preferences only — never affects what's stored anywhere.
// Every length is still measured, persisted, and sent to the server in
// meters (see docs/SPEC.md); "Units" here just changes how a length gets
// formatted for the builder to read, and how a typed number is interpreted
// back into meters. Same localStorage-for-per-device-prefs pattern as
// builderIdentity.js's active-identity choice.
const UNITS_KEY = 'higglehaven.units';
const METERS_PER_FOOT = 0.3048;

export function getUnits() {
  return localStorage.getItem(UNITS_KEY) === 'ft' ? 'ft' : 'm';
}

export function setUnits(units) {
  localStorage.setItem(UNITS_KEY, units === 'ft' ? 'ft' : 'm');
}

export function unitSuffix(units = getUnits()) {
  return units === 'ft' ? 'ft' : 'm';
}

export function toDisplayLength(meters, units = getUnits()) {
  return units === 'ft' ? meters / METERS_PER_FOOT : meters;
}

export function fromDisplayLength(value, units = getUnits()) {
  return units === 'ft' ? value * METERS_PER_FOOT : value;
}

export function formatLength(meters, decimals = 2, units = getUnits()) {
  return `${toDisplayLength(meters, units).toFixed(decimals)}${unitSuffix(units)}`;
}
