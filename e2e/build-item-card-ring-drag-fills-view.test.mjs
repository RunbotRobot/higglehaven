// #4242 (item 3): zoomed in until the item fills the screen, a real press on each rotation ring and a drag
// through it. While a ring is held the item card stays exactly where it docked (it never moves or resizes under
// the finger), is fainter and lets touches through (so it cannot catch the drag), and when the ring is let go the
// card is solid again, where it was. build-item-card-fills-view.test.mjs forces the held state by hand; this one
// gets it the way a person does, from a real ring. 390x844.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Card Ring Drag Fills Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const card = () => page.evaluate(() => {
  const el = document.getElementById('item-card');
  const r = el.getBoundingClientRect();
  return {
    held: el.dataset.held, side: el.dataset.side, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
    pointer: getComputedStyle(el).pointerEvents, opacity: Number(getComputedStyle(el).opacity),
  };
});
const sameBox = (a, b) => a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(1000);

// A catalog item is small even at the closest zoom, so (as the sibling test does) the share of the screen's width an
// item must cover to count as filling the view is lowered, and the camera brought in.
await page.evaluate(() => window.__testSetCardFillsViewShare(0.2));
await page.mouse.move(195, 430);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(1100);
const anchor = await page.evaluate(() => window.__testItemCardAnchor());
check(anchor && anchor.fills === true, 'the item fills the view');
const docked = await card();
console.log('docked card:', JSON.stringify(docked));
check(docked.opacity > 0.9 && docked.pointer !== 'none', 'before any ring is held the card is solid and takes touches');

const ANGLES = { x: 'tiltRed', y: 'tiltGreen', z: 'turn' };
let dragged = 0;
for (const axis of ['z', 'x', 'y']) {
  const points = (await page.evaluate(() => window.__testRotateRingPoints()))[axis] || [];
  let at = null;
  for (const p of points) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(30);
    if ((await page.evaluate(() => window.__testRotateActiveAxis())) === axis.toUpperCase()) { at = p; break; }
  }
  if (!at) { console.log(`no point on the ${axis} ring is on screen at this zoom; skipped`); continue; }
  const before = await page.evaluate(() => window.__testSelectedItemState());
  const resting = await card();
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 30, { steps: 6 });
  const during = await card();
  await page.mouse.move(at.x + 90, at.y + 60, { steps: 10 });
  const later = await card();
  check(during.held === 'true', `a real press on the ${axis} ring marks the card as held`);
  check(during.pointer === 'none' && during.opacity < 0.6, `while the ${axis} ring is held the card is fainter and lets touches through (${JSON.stringify({ p: during.pointer, o: during.opacity })})`);
  check(sameBox(resting, during) && sameBox(during, later), `the card does not move or resize while the ${axis} ring is dragged (${JSON.stringify(resting)} -> ${JSON.stringify(later)})`);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await card();
  const state = await page.evaluate(() => window.__testSelectedItemState());
  check(after.held !== 'true' && after.opacity > 0.9 && after.pointer !== 'none', `when the ${axis} ring is let go the card is solid again`);
  check(sameBox(resting, after), `and it is where it was (${JSON.stringify(resting)} -> ${JSON.stringify(after)})`);
  const moved = Math.abs(state[ANGLES[axis]] - before[ANGLES[axis]]);
  console.log(`the ${axis} ring turned the item by (deg):`, moved);
  check(moved >= 5, `the ${axis} ring really turned the item (${moved} deg), so the drag was a real one`);
  dragged += 1;
}
check(dragged >= 1, 'at least one ring was on screen and dragged');

await finish(browser, { pass: pass && errors.length === 0, label: '#4242: with the item filling the view, a ring drag leaves the docked card still, faint and click-through, then solid again', errors });
