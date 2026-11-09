// #3324 (leaf 1/7 of #3323): a bundle is selected as ONE box, not one per
// member. Three placed items, selected together:
//   - loose: three boxes (one per item);
//   - after Group: the selection re-renders as ONE box around all three,
//     without re-selecting;
//   - Move: the one box follows the bundle;
//   - Ungroup: three boxes again.
// Phone width (launchPage's default 420px viewport).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Box Tester';

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

await placeTreeAt(110, 380);
await placeTreeAt(210, 380);
await placeTreeAt(310, 380);
await page.mouse.click(60, 600); // clear the auto-selection of the last placement
await page.waitForTimeout(300);

const positions = await page.evaluate(() => window.__testProductScreenPositions());
console.log('three trees, screen positions:', JSON.stringify(positions));

await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
for (const pos of positions) {
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(200);
}
const selectionText = await page.textContent('#product-info');
const looseBoxes = await page.evaluate(() => window.__testSelectionBoxes());
console.log('status:', selectionText, '| boxes with three loose items selected (should be 3):', looseBoxes.length);

await page.click('#group-item');
await page.waitForTimeout(700);

// No re-selecting: the selection itself is now one bundle, drawn as one box.
const groupedBoxes = await page.evaluate(() => window.__testSelectionBoxes());
console.log('boxes right after Group (should be 1):', groupedBoxes.length);

// Move the bundle: leaves multi-select (Move exits it, keeping the
// selection), then nudge it up and check the single box follows.
await page.click('#mode-move');
await page.waitForTimeout(300);
const beforeMove = await page.evaluate(() => window.__testSelectionBoxes());
const dragged = await page.evaluate((offsetZ) => window.__testDragGroupMoveZ(offsetZ), 0.5);
await page.waitForTimeout(500);
const afterMove = await page.evaluate(() => window.__testSelectionBoxes());
console.log('group-move applied:', dragged, '| boxes after move (should be 1):', afterMove.length);
const rise = afterMove[0] && beforeMove[0] ? afterMove[0].min[2] - beforeMove[0].min[2] : null;
console.log('the one box rose by (should be ~0.5):', rise);

await page.click('#ungroup-item');
await page.waitForTimeout(700);
const ungroupedBoxes = await page.evaluate(() => window.__testSelectionBoxes());
console.log('boxes after Ungroup (should be 3):', ungroupedBoxes.length);

const pass =
  positions.length === 3 &&
  selectionText.includes('3 items selected') &&
  looseBoxes.length === 3 &&
  groupedBoxes.length === 1 &&
  dragged === true &&
  beforeMove.length === 1 &&
  afterMove.length === 1 &&
  rise !== null && Math.abs(rise - 0.5) < 0.05 &&
  ungroupedBoxes.length === 3 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#3324: a bundle is selected as one box (loose 3, bundled 1, follows a move, ungrouped 3)',
  errors,
});
