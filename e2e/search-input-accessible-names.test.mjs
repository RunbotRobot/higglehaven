// #1506: the Add Item catalog picker's search box (#catalog-search-input)
// and Sell mode's product search box (#seller-search-input) had no
// accessible name at all -- no <label>, aria-label, or aria-labelledby.
// Placeholder text isn't reliably exposed as an accessible name by all
// assistive technology, and it disappears once the user types anything.
// Same bug shape (and same fix idiom -- a real aria-label, matching the
// pattern already used for icon-only buttons) as #1324's icon-button
// accessible-name fix (see e2e/icon-button-accessible-names.test.mjs).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Search Input A11y Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });

const catalogSearchLabel = await page.getAttribute('#catalog-search-input', 'aria-label');
console.log('#catalog-search-input aria-label (should be set):', catalogSearchLabel);

await page.click('#catalog-picker-close-btn');
await page.waitForTimeout(300);
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

const sellerSearchLabel = await page.getAttribute('#seller-search-input', 'aria-label');
console.log('#seller-search-input aria-label (should be set):', sellerSearchLabel);

const pass = Boolean(catalogSearchLabel) && Boolean(sellerSearchLabel) && errors.length === 0;
await finish(browser, {
  pass,
  label: 'Catalog and seller search inputs have a real accessible name (#1506)',
  errors,
});
