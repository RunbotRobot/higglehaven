// #3689 (Build in the bud, slice b): the Move and Rotate buttons are gone. A selected item shows the yaw
// ring, and a drag that starts on the item moves it along the ground (the whole selection when several
// are selected). It runs through the same pipeline as the gizmo's arrows did, so Undo takes it back; a tap
// does not move it; a drag that starts on empty ground leaves it alone. Phone width, real mouse events.
import { launchPage, chooseIdentity, claimLandlet, finish, budClick } from './helpers.mjs';

const LABEL = 'Body Drag Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const state = () => page.evaluate(() => window.__testSelectedItemState());
const screenOf = (index) => page.evaluate((i) => window.__testProductScreenPositions()[i], index);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

await placeTreeAt(160, 380);
check((await page.locator('#mode-move').count()) === 0 && (await page.locator('#mode-rotate').count()) === 0, 'there are no Move and Rotate buttons any more');
const readoutShown = await page.evaluate(() => !document.getElementById('rotation-readout').hidden);
check(readoutShown, 'the ring is on the selected item without pressing anything (its angle line is up)');
// #4118: the red and green tilt rings are back beside the blue turn ring.
const rings = await page.evaluate(() => window.__testRotateRingsShown());
check(rings.x && rings.y && rings.z, `all three rings (red, green, blue) are on the selected item (${JSON.stringify(rings)})`);
// #4118: the card opens clear of the item and its rings (about 100 px round it), not on them.
const clearance = await page.evaluate(() => {
  const anchor = window.__testItemCardAnchor();
  const card = document.getElementById('item-card').getBoundingClientRect();
  if (!anchor || card.width === 0) return null;
  const nx = Math.max(card.left, Math.min(anchor.x, card.right));
  const ny = Math.max(card.top, Math.min(anchor.y, card.bottom));
  return Math.round(Math.hypot(anchor.x - nx, anchor.y - ny));
});
check(clearance !== null && clearance >= 100, `the item card keeps clear of the rings round the item (${clearance} px from the item to the card)`);

const s0 = await state();
const spot = await screenOf(0);

// A tap on the item does not move it.
await page.mouse.move(spot.x, spot.y);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(300);
const sTap = await state();
check(sTap && near(sTap.x, s0.x) && near(sTap.y, s0.y), 'a tap on the selected item does not move it');

// A drag that starts on empty ground leaves the item alone (it orbits the camera).
await page.mouse.move(330, 700);
await page.mouse.down();
await page.mouse.move(280, 690, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
const sEmpty = await state();
check(!sEmpty || (near(sEmpty.x, s0.x) && near(sEmpty.y, s0.y)), 'a drag that starts on empty ground does not move the item');

// A drag from the item moves it along the ground, at the same height.
const spot2 = await screenOf(0);
await page.mouse.move(spot2.x, spot2.y);
await page.mouse.down();
await page.mouse.move(spot2.x + 50, spot2.y + 30, { steps: 8 });
const mid = await page.evaluate(() => window.__testBodyDragActive());
check(mid, 'a drag that starts on the item is a drag of the item');
await page.mouse.up();
await page.waitForTimeout(500);
const sDrag = await state();
const moved = Math.hypot(sDrag.x - s0.x, sDrag.y - s0.y);
check(moved > 0.3, `the item followed the drag along the ground (${moved.toFixed(2)} m)`);
check(near(sDrag.z, s0.z, 0.001), `at the same height (${sDrag.z} vs ${s0.z})`);
check(!(await page.evaluate(() => window.__testBodyDragActive())), 'and the drag is over after the release');

// Undo takes the move back like any other.
await budClick(page, '#undo-btn');
await page.waitForTimeout(1000);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const sUndo = await state();
check(sUndo && near(sUndo.x, s0.x) && near(sUndo.y, s0.y), `Undo takes the drag back (${JSON.stringify(sUndo && { x: sUndo.x, y: sUndo.y })})`);

// A second tree; select both and drag one: the selection moves together.
await placeTreeAt(70, 560);
await page.evaluate(() => window.__testSelectAllProducts());
await page.waitForTimeout(500);
const before = await page.evaluate(() => window.__testProductPositions());
const first = await screenOf(0);
await page.mouse.move(first.x, first.y);
await page.mouse.down();
await page.mouse.move(first.x - 40, first.y + 20, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
const after = await page.evaluate(() => window.__testProductPositions());
const d = before.map((b, i) => ({ dx: after[i].x - b.x, dy: after[i].y - b.y }));
check(Math.hypot(d[0].dx, d[0].dy) > 0.3 && near(d[0].dx, d[1].dx, 0.05) && near(d[0].dy, d[1].dy, 0.05), `both selected items moved by the same amount (${JSON.stringify(d)})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3689: drag from the item moves it (and the selection); the ring is on without a button', errors });
