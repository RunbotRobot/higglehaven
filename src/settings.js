// Local display preferences only — never affects what's stored anywhere.
// Every length is still measured, persisted, and sent to the server in
// meters (see docs/SPEC.md); "Units" here just changes how a length gets
// formatted for the builder to read, and how a typed number is interpreted
// back into meters.
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

export function areaSuffix(units = getUnits()) {
  return units === 'ft' ? 'ft²' : 'm²';
}

// Area scales with the square of length, so this can't reuse
// toDisplayLength's own per-axis factor directly.
export function toDisplayArea(squareMeters, units = getUnits()) {
  return units === 'ft' ? squareMeters / (METERS_PER_FOOT * METERS_PER_FOOT) : squareMeters;
}

// Owner: "Whenever we display a lánd size, please round to the nearest
// integer and show a comma for thousands-separation." Unlike formatLength
// (still 2-decimal by default — used for fine-grained placement/transform
// values, not land-cap-scale areas), every real call site here is a whole
// land/lándlet size, so the default itself rounds; toLocaleString's grouping
// applies regardless of decimals in case a caller ever passes a nonzero one.
export function formatArea(squareMeters, decimals = 0, units = getUnits()) {
  return `${toDisplayArea(squareMeters, units).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${areaSuffix(units)}`;
}
