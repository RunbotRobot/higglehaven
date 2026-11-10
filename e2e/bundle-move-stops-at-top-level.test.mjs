// #3372: moving a bundle above the lándlet's levels stops at the top instead of
// being accepted and then refused on save with a developer message. The
// bundle rests at the limit, the status line says so in plain words, the save
// that follows succeeds, and no "Couldn't save" notice appears.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Top Level Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

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
await page.click('#group-item');
await page.waitForTimeout(700);
await page.click('#mode-move');
await page.waitForTimeout(300);

// Drag far past the top of the only (ground) level.
const dragged = await page.evaluate(() => window.__testDragGroupMoveZ(40));
await page.waitForTimeout(1500);
const status = await page.evaluate(() => ({
  text: document.getElementById('selection-action-status-text')?.textContent ?? '',
  visible: !document.getElementById('selection-action-status')?.hidden,
  zs: window.__testProductScreenPositions().length,
}));
const noticeOpen = await page.evaluate(() => Boolean(document.querySelector('#notice-modal.visible')));
console.log('dragged:', dragged, '| status:', JSON.stringify(status), '| error notice open (should be false):', noticeOpen);

const pass = dragged === true && status.visible
  && /as high as this l[aá]ndlet goes/.test(status.text)
  && !/z \(|POST|landlets\//.test(status.text)
  && !noticeOpen && errors.length === 0;
await finish(browser, { pass, label: '#3372: a bundle moved past the top level stops there with a plain notice and saves cleanly', errors });
