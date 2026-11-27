// #4602 (Shipping 5/8, part of #4394): Settings > Shop has "Dim what cannot ship to me", off until turned on, and a
// country to judge by for someone with no address; both are kept on the account and come back after a reload.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Dim Switch Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });

async function openShopSettings() {
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
  await page.click('.settings-tab-btn[data-section="shop"]');
  await page.waitForSelector('#settings-dim-unshippable', { timeout: 30000 });
}

await openShopSettings();
const offAtFirst = !(await page.isChecked('#settings-dim-unshippable'));
await page.check('#settings-dim-unshippable');
await page.selectOption('#settings-shipping-country', 'FR');
await page.waitForTimeout(800);

const saved = await page.evaluate(async () => (await (await fetch('/api/shipping-destination', { credentials: 'include' })).json()).destination);
console.log({ offAtFirst, saved });
const pass = offAtFirst && saved.dimUnshippable === true && saved.country === 'FR' && saved.source === 'chosen' && errors.length === 0;
await finish(browser, { pass, label: '#4602: Settings > Shop keeps the dim switch and the country on the account', errors });
