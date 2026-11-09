// #3330: deleting a saved bundle detaches its placed copies (they stay in the
// world, unlinked), and the Delete confirmation tells the creator how many
// copies that affects before they confirm.
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs, acceptConfirmModal } from './helpers.mjs';

const LABEL = 'Bundle Delete Count Tester';
const NAME = 'Count Bundle';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
await placeTreeAt(160, 380);
await placeTreeAt(260, 380);
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
const [posA, posB] = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);
await saveBundleAs(page, NAME);
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.waitForSelector('.bundle-tile', { timeout: 10000 });
await page.locator('.bundle-tile').filter({ hasText: NAME }).locator('.bundle-tile-delete').click();
const message = await acceptConfirmModal(page);
console.log('confirm message:', JSON.stringify(message));
// The deleted bundle was the only one, so the picker's bundle section hides.
await page.waitForFunction(() => document.getElementById('bundle-picker-section').hidden, null, { timeout: 10000 });
// Both placed trees stay in the world (No silent loss).
const stillPlaced = (await page.evaluate(() => window.__testProductScreenPositions())).length;
const pass = stillPlaced === 2 && /1 placed copy of it will stay where it is, but will no longer be linked/.test(message) && errors.length === 0;
await finish(browser, { pass, label: '#3330: delete confirmation states how many placed copies get unlinked', errors });
