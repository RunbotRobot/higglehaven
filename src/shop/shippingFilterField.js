// #4602 (Shipping 5/8, part of #4394): Settings > Shop > "Dim what cannot ship to me". One checkbox, remembered on the
// account, off until turned on; and, for a person who keeps no address yet, a country to judge by. The server holds both
// and decides the country (the default address wins); this shows what it says and tells the shop what changed.
import { fetchShippingDestination, saveShippingDestination } from '../api.js';
import { setShippingDestination } from './shippingDestination.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Appends the field to `host` once the server has answered; a signed-out visitor (a refusal) sees nothing.
export async function renderShippingFilterField(host, { isCurrent = () => true } = {}) {
  let facts;
  try {
    facts = await fetchShippingDestination();
  } catch {
    return;
  }
  if (!isCurrent()) return;
  setShippingDestination(facts.destination);

  const field = el('div', 'settings-field');
  field.id = 'settings-shipping-filter';
  field.appendChild(el('span', '', 'Shipping'));
  const row = el('div', 'settings-radio-row');
  const label = el('label');
  const box = el('input');
  box.type = 'checkbox';
  box.id = 'settings-dim-unshippable';
  box.checked = facts.destination.dimUnshippable;
  label.append(box, document.createTextNode('Dim what cannot ship to me'));
  row.appendChild(label);
  field.appendChild(row);
  const status = el('div', 'settings-empty-note');
  status.setAttribute('role', 'status');
  field.appendChild(status);

  const country = el('div');
  const hasAddress = facts.destination.source === 'address';
  if (!hasAddress) {
    const select = el('select');
    select.id = 'settings-shipping-country';
    select.setAttribute('aria-label', 'Country I ship to');
    select.appendChild(new Option('Choose a country', ''));
    for (const choice of facts.countries) select.appendChild(new Option(choice.name, choice.code));
    select.value = facts.destination.chosenCountry || '';
    select.addEventListener('change', () => save({ country: select.value || null }));
    select.className = 'settings-shipping-country';
    country.append(el('div', 'settings-empty-note', 'Country I ship to'), select,
      el('div', 'settings-empty-note', 'Adding an address in Settings uses its country instead.'));
    field.appendChild(country);
  }
  host.appendChild(field);

  async function save(change) {
    status.textContent = '';
    status.classList.remove('error');
    try {
      const result = await saveShippingDestination(change);
      setShippingDestination(result.destination);
      facts.destination = result.destination;
    } catch (err) {
      // The refusal stays until dismissed by the next try, and can be selected (nothing disables selection).
      status.textContent = err.message || "Couldn't save that.";
      status.classList.add('error');
      box.checked = facts.destination.dimUnshippable;
    }
  }
  box.addEventListener('change', () => save({ dimUnshippable: box.checked }));
}
