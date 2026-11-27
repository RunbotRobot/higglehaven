// #4598 (Shipping 1/8, part of #4394): "Addresses" in Settings > General, under Account and tax, in every mode. A person
// keeps the places they ship to: one row per address (name, the lines, a "Default" word on the default), Edit, Make
// default, Remove (confirmed in its own modal), and one form to add or edit. The server decides every rule (which field
// is wrong, the cap, which countries need a region); the client only shows what it says. Required fields start empty
// with one helper line, and a refusal names the field, stays until dismissed and can be selected.
import { fetchAddresses, addAddress, editAddress, removeAddress, makeAddressDefault } from '../api.js';
import { confirmDestructive } from '../ui/confirmModal.js';
import { showInlineActionStatus } from '../ui/inlineActionStatus.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// One line a person can read the address in.
export function addressLines(address, countryName) {
  const cityLine = [address.city, address.region, address.postalCode].filter(Boolean).join(', ');
  return [address.recipientName, address.line1, address.line2, cityLine, countryName || address.country].filter(Boolean);
}

// Draws the field into `host`. `isCurrent()` says whether Settings has since been redrawn (a tab switch or a reopen),
// in which case a late answer must not draw into a stale screen. `confirmOptions` places the removal modal over Settings.
export async function renderAddressesField(host, { isCurrent, confirmOptions = {} }) {
  const field = el('div', 'settings-field');
  field.id = 'settings-addresses';
  field.appendChild(el('span', '', 'Addresses'));
  const body = el('div');
  body.appendChild(el('div', 'settings-empty-note', 'Loading…'));
  field.appendChild(body);
  host.appendChild(field);

  let facts;
  try {
    facts = await fetchAddresses();
  } catch (err) {
    if (!isCurrent()) return;
    body.replaceChildren(el('div', 'settings-empty-note error', err.message || "Couldn't load your addresses."));
    return;
  }
  if (!isCurrent()) return;

  let { addresses } = facts;
  const countryName = (code) => facts.countries.find((country) => country.code === code)?.name;

  function draw() {
    body.replaceChildren();
    if (addresses.length === 0) {
      body.appendChild(el('div', 'settings-empty-note', 'No addresses yet.'));
    }
    for (const address of addresses) body.appendChild(drawRow(address));
    if (addresses.length < facts.maxAddresses) {
      const add = el('button', 'version-action-btn', 'Add an address');
      add.type = 'button';
      add.id = 'settings-address-add-btn';
      add.addEventListener('click', () => openForm(null, add));
      body.appendChild(add);
    } else {
      body.appendChild(el('div', 'settings-empty-note', `You can keep up to ${facts.maxAddresses} addresses. Remove one to add another.`));
    }
  }

  function drawRow(address) {
    const row = el('div', 'settings-field');
    row.dataset.addressId = address.addressId;
    const lines = el('div');
    addressLines(address, countryName(address.country)).forEach((line, index) => {
      lines.appendChild(el('div', index === 0 ? '' : 'settings-empty-note', line));
    });
    if (address.isDefault) lines.appendChild(el('div', 'settings-empty-note', 'Default'));
    row.appendChild(lines);
    const actions = el('div', 'settings-radio-row');
    const edit = el('button', 'version-action-btn', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => openForm(address, edit));
    actions.appendChild(edit);
    if (!address.isDefault) {
      const makeDefault = el('button', 'version-action-btn', 'Make default');
      makeDefault.type = 'button';
      makeDefault.addEventListener('click', async () => {
        makeDefault.disabled = true;
        try {
          addresses = (await makeAddressDefault(address.addressId)).addresses;
          if (isCurrent()) draw();
        } catch (err) {
          makeDefault.disabled = false;
          showInlineActionStatus(row, err.message || "Couldn't change your default address.");
        }
      });
      actions.appendChild(makeDefault);
    }
    const remove = el('button', 'version-action-btn', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      const confirmed = await confirmDestructive({
        title: 'Remove this address?',
        message: `${addressLines(address, countryName(address.country)).join(', ')} will be removed from your account. Orders already placed keep the address they were sent to.`,
        confirmLabel: 'Remove address',
        returnFocusEl: remove,
        ...confirmOptions,
        onConfirm: async () => { await removeAddress(address.addressId); },
      });
      if (!confirmed || !isCurrent()) return;
      try {
        addresses = (await fetchAddresses()).addresses;
        draw();
      } catch (err) {
        showInlineActionStatus(row, err.message || "Couldn't reload your addresses.");
      }
    });
    actions.appendChild(remove);
    row.appendChild(actions);
    return row;
  }

  function openForm(existing, returnFocusEl) {
    body.replaceChildren();
    const form = el('div', 'stripe-onboarding-form');
    form.id = 'settings-address-form';
    const inputs = {};
    const specs = [
      ['recipientName', 'Name', 'text', 100],
      ['line1', 'Address', 'text', 120],
      ['line2', 'Apartment, suite or unit (optional)', 'text', 120],
      ['city', 'City', 'text', 80],
      ['region', 'State or region', 'text', 80],
      ['postalCode', 'Postal code', 'text', 12],
    ];
    for (const [key, labelText, type, maxLength] of specs) {
      const label = el('label', '', labelText);
      const input = el('input');
      input.type = type;
      input.maxLength = maxLength;
      input.value = existing?.[key] ?? '';
      label.appendChild(input);
      form.appendChild(label);
      inputs[key] = input;
    }
    const countryLabel = el('label', '', 'Country');
    const select = el('select');
    select.appendChild(new Option('Choose a country', ''));
    for (const country of facts.countries) select.appendChild(new Option(country.name, country.code));
    select.value = existing?.country ?? '';
    countryLabel.appendChild(select);
    form.appendChild(countryLabel);
    inputs.country = select;
    const phoneLabel = el('label', '', 'Phone for the carrier (optional)');
    const phone = el('input');
    phone.type = 'tel';
    phone.maxLength = 20;
    phone.value = existing?.phone ?? '';
    phoneLabel.appendChild(phone);
    form.appendChild(phoneLabel);
    inputs.phone = phone;
    body.appendChild(form);
    body.appendChild(el('div', 'settings-empty-note',
      `A state or region is needed for ${facts.regionRequiredFor.map((code) => countryName(code) || code).join(', ')}.`));

    const save = el('button', 'version-action-btn', existing ? 'Save address' : 'Add address');
    save.type = 'button';
    const cancel = el('button', 'version-action-btn', 'Cancel');
    cancel.type = 'button';
    const status = el('div', 'settings-empty-note');
    status.setAttribute('role', 'status');
    body.append(save, cancel, status);

    cancel.addEventListener('click', () => { draw(); returnFocusEl?.focus?.(); });
    save.addEventListener('click', async () => {
      const payload = {};
      for (const [key, input] of Object.entries(inputs)) payload[key] = input.value;
      status.textContent = '';
      status.classList.remove('error');
      save.disabled = true;
      try {
        if (existing) await editAddress(existing.addressId, payload);
        else await addAddress(payload);
        addresses = (await fetchAddresses()).addresses;
        if (isCurrent()) draw();
      } catch (err) {
        status.textContent = err.message || "Couldn't save this address.";
        status.classList.add('error');
        // The server names the field; put the cursor there.
        const wrong = err.field && inputs[err.field];
        if (wrong) wrong.focus();
      } finally {
        save.disabled = false;
      }
    });
    inputs.recipientName.focus();
  }

  draw();
}
