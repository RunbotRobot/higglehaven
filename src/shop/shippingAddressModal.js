// #4599 (shipping, 2/8): the one small form that asks where a shipped product goes. Opened by Buy before anything is
// sent, for every way of paying; digital goods never open it. It checks that each needed line is filled in so the
// person sees what is missing where they are typing; the server checks again and decides, and the address it is sent
// is kept on the order as its own copy. Nothing is stored in this browser: the last address is only remembered until
// the page is closed, so buying two things does not mean typing it twice.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { shippingCountryOptions } from './shippingCountries.js';
import { shippingZoneOfCountry, SHIPPING_ZONE_IDS } from '../../shared/shipping-zones.js';

const modalEl = document.getElementById('shipping-address-modal');
const formEl = document.getElementById('shipping-address-form');
const cancelBtn = document.getElementById('shipping-address-cancel-btn');
const countryEl = document.getElementById('shipping-address-country');
const noteEl = document.getElementById('shipping-address-note');
const errorEl = document.getElementById('shipping-address-error');
const FIELDS = {
  name: document.getElementById('shipping-address-name'),
  line1: document.getElementById('shipping-address-line1'),
  line2: document.getElementById('shipping-address-line2'),
  city: document.getElementById('shipping-address-city'),
  region: document.getElementById('shipping-address-region'),
  postalCode: document.getElementById('shipping-address-postal'),
};
const LABELS = { name: 'a name', line1: 'a street address', city: 'a city', postalCode: 'a postal code', region: 'a state' };

let lastAddress = null; // until the page closes only, never stored
let resolveAsk = null;
let countriesBuilt = false;

function buildCountries() {
  if (countriesBuilt) return;
  for (const { code, name } of shippingCountryOptions()) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    countryEl.appendChild(option);
  }
  countriesBuilt = true;
}

function close(result) {
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  const resolve = resolveAsk;
  resolveAsk = null;
  resolve?.(result);
}

// The first line still missing, in words, or null when the form is complete.
export function missingAddressLine(address) {
  for (const field of ['name', 'line1', 'city', 'postalCode']) {
    if (!address[field]) return field;
  }
  if (address.country === 'US' && !address.region) return 'region';
  return null;
}

function readForm() {
  const address = { country: countryEl.value };
  for (const [field, el] of Object.entries(FIELDS)) address[field] = el.value.trim();
  return address;
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const address = readForm();
  const missing = missingAddressLine(address);
  if (missing) {
    errorEl.hidden = false;
    errorEl.textContent = `Add ${LABELS[missing]}.`;
    (missing === 'region' ? FIELDS.region : FIELDS[missing]).focus();
    return;
  }
  errorEl.hidden = true;
  lastAddress = address;
  close(address);
});
cancelBtn.addEventListener('click', () => close(null));

// Resolves to the address as typed ({ name, line1, line2, city, region, postalCode, country }), or null when the
// person closes the form. `zones`: the zones the seller sends to (#4601); only the countries in them are offered, and
// when that is not everywhere the form says where it ships (`places`, in words).
export function promptShippingAddress({ zones = SHIPPING_ZONE_IDS, places = '' } = {}) {
  const restricted = zones.length < SHIPPING_ZONE_IDS.length;
  const offered = (code) => zones.includes(shippingZoneOfCountry(code));
  buildCountries();
  return new Promise((resolve) => {
    resolveAsk = resolve;
    const start = lastAddress || { name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: 'US' };
    for (const [field, el] of Object.entries(FIELDS)) el.value = start[field] || '';
    for (const option of countryEl.options) option.hidden = restricted && !offered(option.value);
    const first = [...countryEl.options].find((option) => !option.hidden);
    countryEl.value = offered(start.country || 'US') ? start.country || 'US' : first?.value || 'US';
    noteEl.hidden = !restricted;
    noteEl.textContent = restricted ? `The seller sends this to ${places}.` : '';
    errorEl.hidden = true;
    modalEl.classList.add('visible');
    openModalA11y(modalEl, () => close(null));
    FIELDS.name.focus();
  });
}
