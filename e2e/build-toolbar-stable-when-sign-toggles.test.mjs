// #3576: turning Community Sign on changed that button's label to the wider
// a wider "...Manage" label, the selection toolbar re-wrapped and Delete
// moved onto the item. Every toolbar button must stay exactly where it was
// when the toggle flips, at phone width.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Toolbar Stability Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const IDS = ['toggle-community-sign', 'toggle-community-calendar', 'toggle-backup-chain', 'delete-item', 'group-item', 'edit-bundle-item'];
const positions = () => page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
  const el = document.getElementById(id);
  if (!el || el.offsetParent === null) return [id, null];
  const r = el.getBoundingClientRect();
  return [id, [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]];
})), IDS);

const before = await positions();
await page.click('#toggle-community-sign');
await page.waitForFunction(() => document.getElementById('toggle-community-sign')?.textContent.includes('Manage'), null, { timeout: 10000 });
await page.waitForTimeout(300);
const afterSign = await positions();
const label = await page.textContent('#toggle-community-sign');
console.log('label after toggling on:', label);
console.log('before:', JSON.stringify(before));
console.log('after: ', JSON.stringify(afterSign));

const unchanged = JSON.stringify(before) === JSON.stringify(afterSign);
const pass = unchanged && label.includes('Manage') &&
  errors.filter((e) => !e.includes('Failed to load resource')).length === 0;
await finish(browser, { pass, label: 'The selection toolbar does not move when Community Sign is toggled on (#3576)', errors });
