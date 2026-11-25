// #4357: with an item selected, opening a leaf (Tools) no longer draws it over the item card with both showing
// through each other. The card steps aside while the leaf is open (the item stays selected) and is back, with the
// same item, when the leaf closes. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Leaf Over Card Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const card = () => page.evaluate(() => {
  const el = document.getElementById('item-card');
  const style = getComputedStyle(el);
  return { visible: !el.hidden && style.visibility !== 'hidden' && el.getBoundingClientRect().height > 0, name: document.getElementById('item-card-name').textContent };
});

// Place a tree: placing leaves it selected, so its card is open.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(220, 420);
await page.waitForTimeout(900);
const before = await card();
console.log('card with the tree selected:', JSON.stringify(before));
check(before.visible && /Tree/.test(before.name), 'the card of the selected tree is shown');

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.click('#bud-petal-build-tools');
await page.waitForSelector('#bud-leaf-tools', { timeout: 5000 });
await page.waitForTimeout(400);
const during = await card();
console.log('card while the Tools leaf is open:', JSON.stringify(during));
check(!during.visible, 'the card is not drawn while the leaf is open');
check(during.name === before.name, 'the tree is still selected while the leaf is open');

await page.click('.bud-leaf-close');
await page.waitForTimeout(600);
const after = await card();
console.log('card after the leaf closes:', JSON.stringify(after));
check(after.visible && after.name === before.name, 'the card is back, for the same tree, when the leaf closes');

await finish(browser, { pass: pass && errors.length === 0, label: '#4357: a leaf opened over a selected item hides the item card, and the card returns when it closes', errors });
