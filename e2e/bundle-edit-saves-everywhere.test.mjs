// #3329 (leaf 6/7 of #3323): leaving Edit on a saved bundle saves what changed
// to the template, so another builder's copy is re-laid and they are told.
// Phone width (launchPage's default 420px viewport).
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs, acceptConfirmModal } from './helpers.mjs';

const OWNER = 'Bundle Sync Owner';
const OTHER = 'Bundle Sync Other';
const ownerSession = await launchPage({ promptAnswer: OWNER });
const otherSession = await launchPage({ promptAnswer: OTHER });
const page = ownerSession.page;
const other = otherSession.page;

await chooseIdentity(page, { mode: 'build', label: OWNER, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function placeTreeAt(p, x, y) {
  await p.click('#add-item-btn');
  await p.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await p.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await p.waitForTimeout(300);
  await p.mouse.click(x, y);
  await p.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), null, { timeout: 60000 });
}

await placeTreeAt(page, 160, 380);
await placeTreeAt(page, 260, 380);
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
const positions = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
for (const pos of positions) {
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(200);
}
await page.click('#group-item');
await page.waitForTimeout(700);
await saveBundleAs(page, OWNER, { shared: true });
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });

// The other builder places the shared bundle.
await chooseIdentity(other, { mode: 'build', label: OTHER, isNew: true });
await claimLandlet(other);
await other.click('#add-item-btn');
await other.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await other.click('.bundle-tab-btn[data-bundle-tab="community"]');
await other.waitForTimeout(500);
await other.locator('.bundle-tile').filter({ hasText: OWNER }).locator('.bundle-tile-place').click();
await other.waitForTimeout(300);
await other.mouse.click(210, 500);
await other.waitForFunction(() => document.getElementById('product-info').textContent.includes('items selected'), null, { timeout: 60000 });
await other.waitForTimeout(800);

const bundleItems = () => page.evaluate(async () => {
  const res = await fetch('/api/bundles');
  const { bundles } = await res.json();
  return bundles[0].items.map((item) => item.dx);
});
const before = await bundleItems();

// Owner selects the bundle, opens it, moves one member, and leaves edit mode.
await page.evaluate(() => window.__testSelectAllProducts());
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('items selected'), null, { timeout: 15000 });
await page.waitForSelector('#edit-bundle-item', { state: 'visible', timeout: 15000 });
await page.waitForFunction(() => !document.getElementById('edit-bundle-item').disabled, null, { timeout: 15000 });
await page.click('#edit-bundle-item');
await acceptConfirmModal(page);
await page.waitForTimeout(300);
const member = await page.evaluate(() => window.__testProductScreenPositions());
await page.mouse.click(member[1].x, member[1].y);
await page.waitForTimeout(300);
await page.evaluate(() => window.__testNudgeSelected(1.5));
await page.click('#edit-bundle-item'); // Done
await page.waitForFunction(() => document.getElementById('selection-action-status')?.textContent.includes('Saved.') || document.body.textContent.includes('everywhere it is placed'), null, { timeout: 30000 });

const changed = await bundleItems();
const notices = await other.evaluate(async () => {
  const res = await fetch('/api/notifications');
  const { notifications } = await res.json();
  return notifications.map((n) => n.message).filter((m) => m.includes('changed the bundle'));
});
console.log('template members before / after:', before, changed);
console.log('other builder notices:', notices);

const errors = [...ownerSession.errors, ...otherSession.errors];
const pass = JSON.stringify(before) !== JSON.stringify(changed)
  && notices.length === 1 && notices[0].includes(`"${OWNER}"`) && notices[0].includes('Unbundle it')
  && errors.length === 0;
await otherSession.browser.close();
await finish(ownerSession.browser, { pass, label: 'bundle edit saves to the template and tells other builders', errors });
