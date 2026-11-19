// #3704 (Sell in the bud, 6/6, slice 2): the shop name lives in the Storefront leaf, Rename works
// from it, and Settings no longer has a Sell tab.
import { launchPage, chooseIdentity, openStorefrontLeaf, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Storefront Leaf Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#account-menu-toggle', { state: 'visible', timeout: 30000 });

await openStorefrontLeaf(page);
await page.waitForSelector('#bud-leaf-storefront button:has-text("Rename")', { timeout: 15000 });
const text = await page.locator('#bud-leaf-storefront').innerText();
const showsName = text.includes(LABEL);
console.log('Leaf shows the shop name (should be true):', showsName);
const hasReset = await page.locator('#bud-leaf-storefront button:has-text("Reset Profile")').count();
console.log('Leaf offers Reset Profile (should be 1):', hasReset);

// Close the leaf, open Settings: no Sell tab, and it opens on General.
await page.click('#bud-leaf-storefront .bud-leaf-close');
await page.waitForSelector('#bud-leaf-storefront', { state: 'detached', timeout: 5000 });
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
const sellTab = await page.locator('.settings-tab-btn[data-section="sell"]').count();
const generalActive = await page.locator('.settings-tab-btn[data-section="general"]').evaluate((e) => e.classList.contains('active'));
console.log('Settings has no Sell tab (should be 0):', sellTab, '; opens on General (should be true):', generalActive);

const pass = showsName && hasReset === 1 && sellTab === 0 && generalActive && errors.length === 0;
await finish(browser, { pass, label: '#3704: the Storefront leaf holds the shop name; Settings has no Sell tab', errors });
