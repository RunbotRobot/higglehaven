// #4599 (shipping, 2/8): the one small form that asks where a shipped product goes. Opened by Buy before anything is
// sent, for every way of paying; digital goods never open it. It checks that each needed line is filled in so the
// person sees what is missing where they are typing; the server checks again and decides, and the address it is sent
// is kept on the order as its own copy. Nothing is stored in this browser: the last address is only remembered until
// the page is closed, so buying two things does not mean typing it twice.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { shippingCountryOptions } from './shippingCountries.js';
import { fetchAddresses, addAddress } from '../api.js';
import { formFromSaved, savedFromForm, sameAsSaved, savedFittingCountries, startingSaved, savedLabel } from './savedAddressChoice.js';

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

const savedLabelEl = document.getElementById('shipping-address-saved-label');
const savedEl = document.getElementById('shipping-address-saved');
const keepLabelEl = document.getElementById('shipping-address-save-label');
const keepEl = document.getElementById('shipping-address-save');
const MAX_SAVED_ADDRESSES = 10; // the account's own limit (worker/lib/addresses.js)
let saved = []; // the person's addresses, read when the form opens
let offered = false; // the account's addresses have been read (so keeping one can be offered)
let typed = false; // the person has started typing, so what they typed is not replaced by a saved address
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
  // #4674: kept on the account when asked and not already there; the purchase never waits on it or fails because of it.
  if (keepEl.checked && !keepLabelEl.hidden && !saved.some((entry) => sameAsSaved(address, entry))) {
    addAddress(savedFromForm(address)).catch(() => {});
  }
  close(address);
});
cancelBtn.addEventListener('click', () => close(null));
// The keep tick is for an address the account does not have yet: gone when the form shows one it keeps, or the account is full.
function refreshKeep() {
  const known = saved.some((entry) => sameAsSaved(readForm(), entry));
  keepLabelEl.hidden = known || saved.length >= MAX_SAVED_ADDRESSES || !offered;
}
formEl.addEventListener('input', (event) => {
  if (event.target !== savedEl) typed = true;
  refreshKeep();
});

function fillForm(address, countries) {
  for (const [field, el] of Object.entries(FIELDS)) el.value = address[field] || '';
  const limited = Array.isArray(countries);
  countryEl.value = limited ? (countries.includes(address.country) ? address.country : countries[0] || '') : address.country || 'US';
}

// Read what the account keeps and offer it: the default (or first that the seller sends to) fills the form if the person
// has not started typing, a chooser lists the rest, and a new address can be kept for next time. The form is open and
// usable the whole time; this only adds to it.
async function offerSaved(countries, touched) {
  let list = [];
  try { list = (await fetchAddresses()).addresses || []; } catch { return; }
  saved = list;
  offered = true;
  const fitting = savedFittingCountries(list, countries);
  keepEl.checked = list.length === 0; // the first address is kept unless unticked; later ones only when ticked
  if (fitting.length === 0) { refreshKeep(); return; }
  savedEl.replaceChildren();
  for (const entry of fitting) {
    const option = document.createElement('option');
    option.value = entry.addressId;
    option.textContent = savedLabel(entry);
    savedEl.appendChild(option);
  }
  const other = document.createElement('option');
  other.value = '';
  other.textContent = 'A different address';
  savedEl.appendChild(other);
  const start = startingSaved(fitting);
  if (!touched() && start) {
    savedEl.value = start.addressId;
    fillForm(formFromSaved(start), countries);
  } else {
    // What is already in the form (an address from earlier in this visit, or one being typed) names its kept twin if it has one.
    const twin = fitting.find((entry) => sameAsSaved(readForm(), entry));
    savedEl.value = twin ? twin.addressId : '';
  }
  savedLabelEl.hidden = false;
  refreshKeep();
  savedEl.onchange = () => {
    const chosen = fitting.find((entry) => entry.addressId === savedEl.value);
    if (chosen) fillForm(formFromSaved(chosen), countries);
    else fillForm({ name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: countryEl.value }, countries);
    refreshKeep();
  };
}

// Resolves to the address as typed ({ name, line1, line2, city, region, postalCode, country }), or null when the
// person closes the form. `countries`: the country codes the seller sends this product to (null or absent: everywhere),
// so only those are offered; `places` is the same in words, for the note ("United States only").
export function promptShippingAddress({ countries = null, places = '' } = {}) {
  buildCountries();
  const limited = Array.isArray(countries);
  return new Promise((resolve) => {
    resolveAsk = resolve;
    const start = lastAddress || { name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: 'US' };
    for (const [field, el] of Object.entries(FIELDS)) el.value = start[field] || '';
    for (const option of countryEl.options) option.hidden = limited && !countries.includes(option.value);
    const first = limited ? (countries.includes(start.country) ? start.country : countries[0] || '') : '';
    countryEl.value = limited ? first : start.country || 'US';
    noteEl.hidden = !limited;
    noteEl.textContent = limited ? `The seller sends this to ${places || 'some countries only'}.` : '';
    errorEl.hidden = true;
    savedLabelEl.hidden = true;
    keepLabelEl.hidden = true;
    keepEl.checked = false;
    saved = [];
    offered = false;
    modalEl.classList.add('visible');
    openModalA11y(modalEl, () => close(null));
    FIELDS.name.focus();
    typed = false;
    offerSaved(limited ? countries : null, () => typed || lastAddress !== null);
  });
}
