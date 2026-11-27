// #4598 (Shipping 1/8, part of #4394): the places a person ships to, in Settings > General > Account and tax: no
// addresses to start; the form starts empty; a refusal names the field and says why and keeps what was typed; add
// one (it is the default), add a second, make the second the default, edit it, and remove one through its own
// confirmation modal.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Addresses Suite Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="general"]');
await page.waitForSelector('#settings-addresses', { state: 'attached', timeout: 60000 });
// It sits behind the closed "Account and tax" row.
await page.evaluate(() => { document.querySelector('.settings-account-fold').open = true; });
await page.waitForSelector('#settings-address-add-btn', { timeout: 30000 });

const noneYet = (await page.locator('#settings-addresses').innerText()).includes('No addresses yet.');

await page.click('#settings-address-add-btn');
const emptyForm = await page.evaluate(() => [...document.querySelectorAll('#settings-address-form input')].every((input) => input.value === '')
  && document.querySelector('#settings-address-form select').value === '');

const fill = async (values) => {
  const labels = {
    recipientName: 'Name', line1: 'Address', city: 'City', region: 'State or region', postalCode: 'Postal code',
  };
  for (const [key, text] of Object.entries(labels)) {
    if (values[key] !== undefined) await page.locator('#settings-address-form label', { hasText: new RegExp(`^${text}`) }).locator('input').fill(values[key]);
  }
  if (values.country !== undefined) await page.selectOption('#settings-address-form select', values.country);
};

// Everything but the country: refused, naming the field, and what was typed stays.
await fill({ recipientName: 'Sam Rivera', line1: '12 Pine Street', city: 'Seattle', region: 'WA', postalCode: '98101' });
await page.click('button:has-text("Add address")');
await page.waitForSelector('#settings-address-form ~ .settings-empty-note.error', { timeout: 10000 });
const refusal = await page.locator('#settings-address-form ~ .settings-empty-note.error').innerText();
const keptTyping = (await page.locator('#settings-address-form label', { hasText: /^Name/ }).locator('input').inputValue()) === 'Sam Rivera';

await fill({ country: 'US' });
await page.click('button:has-text("Add address")');
await page.waitForSelector('#settings-addresses [data-address-id]', { timeout: 10000 });
const firstRow = await page.locator('#settings-addresses [data-address-id]').first().innerText();

// A second one; the first stays the default until the person moves it.
await page.click('#settings-address-add-btn');
await fill({ recipientName: 'Sam Rivera', line1: '9 Elm Road', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' });
await page.click('button:has-text("Add address")');
await page.waitForFunction(() => document.querySelectorAll('#settings-addresses [data-address-id]').length === 2, null, { timeout: 10000 });
await page.locator('#settings-addresses [data-address-id]', { hasText: '9 Elm Road' }).locator('button:has-text("Make default")').click();
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('#settings-addresses [data-address-id]')];
  return rows[0]?.textContent.includes('9 Elm Road') && rows[0].textContent.includes('Default');
}, null, { timeout: 10000 });

// Edit it.
await page.locator('#settings-addresses [data-address-id]', { hasText: '9 Elm Road' }).locator('button:has-text("Edit")').click();
await fill({ line1: '11 Elm Road' });
await page.click('button:has-text("Save address")');
await page.waitForSelector('#settings-addresses [data-address-id]:has-text("11 Elm Road")', { timeout: 10000 });

// Remove the other one: its own confirmation modal, then it is gone and the default is untouched.
await page.locator('#settings-addresses [data-address-id]', { hasText: '12 Pine Street' }).locator('button:has-text("Remove")').click();
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const confirmText = await page.locator('#confirm-modal-message').innerText();
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(() => document.querySelectorAll('#settings-addresses [data-address-id]').length === 1, null, { timeout: 10000 });
const lastRow = await page.locator('#settings-addresses [data-address-id]').first().innerText();

console.log({ noneYet, emptyForm, refusal, keptTyping, firstRow, confirmText, lastRow });
const pass = noneYet && emptyForm && /Country is required/.test(refusal) && keptTyping
  && /12 Pine Street/.test(firstRow) && /Default/.test(firstRow)
  && /12 Pine Street/.test(confirmText) && /11 Elm Road/.test(lastRow) && /Default/.test(lastRow)
  // The one refusal above is a real 400 the browser logs; anything else is a failure.
  && errors.filter((message) => !/status of 400/.test(message)).length === 0;
await finish(browser, { pass, label: '#4598: Settings > Addresses adds, refuses by field, defaults, edits and removes', errors: errors.filter((message) => !/status of 400/.test(message)) });
