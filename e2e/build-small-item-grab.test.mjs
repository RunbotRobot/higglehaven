// #4410: a drag has to start on the selected item, and a small or far-off item is a few pixels wide on a phone. A press
// within 22 px of the middle of a small selected item now counts as on it (the 44 px a finger needs); a press farther
// away is still the view's, and a tap that does not move changes nothing. 390x844, a mouse standing in for a finger.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Small Item Grab Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const state = () => page.evaluate(() => window.__testSelectedItemState());
const core = () => page.evaluate(() => window.__testItemScreenCore());

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).first().click();
await page.waitForTimeout(300);
await page.mouse.click(195, 430);
await page.waitForTimeout(1000);

// Zoom out until the whole item is small on screen.
let c = await core();
for (let i = 0; i < 14 && c && c.radius > 14; i++) {
  await page.mouse.move(330, 700);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(450);
  c = await core();
}
console.log('item on screen:', JSON.stringify(c));
check(c && c.radius < 22, `the item is small on screen (radius ${c?.radius?.toFixed(1)} px)`);
const stillSelected = await state();
check(!!stillSelected, 'and still selected');

// 16 px beside it, away from the rings' picking (the rings are far wider than a small item: a press there may be a
// ring's; look for a spot where no handle is under the finger).
async function spot(minDist, maxDist) {
  for (let r = minDist; r <= maxDist; r += 2) {
    for (let a = 0; a < 360; a += 20) {
      const x = c.x + Math.cos((a * Math.PI) / 180) * r;
      const y = c.y + Math.sin((a * Math.PI) / 180) * r;
      const hit = await page.evaluate(([px, py]) => ({ h: window.__testHandleAt(px, py), body: window.__testSelectedItemHitAt(px, py) }), [x, y]);
      if (!hit.h.ring && !hit.h.arrow && !hit.body) return { x, y };
    }
  }
  return null;
}
const near = await spot(10, 20);
console.log('a press beside the item:', JSON.stringify(near));
check(!!near, 'a spot beside the item with no handle under it');
if (near) {
  const before = await state();
  await page.mouse.move(near.x, near.y);
  await page.mouse.down();
  await page.mouse.move(near.x + 40, near.y + 20, { steps: 8 });
  check(await page.evaluate(() => window.__testBodyDragActive()), 'a drag that starts just beside a small item is a drag of the item');
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await state();
  check(Math.hypot(after.x - before.x, after.y - before.y) > 0.2, 'and the item followed it');
}

// Far from it, a drag is the view's, and the item stays put.
const farOnes = await spot(60, 90);
if (farOnes) {
  const before = await state();
  await page.mouse.move(farOnes.x, farOnes.y);
  await page.mouse.down();
  await page.mouse.move(farOnes.x + 40, farOnes.y + 20, { steps: 8 });
  check(!(await page.evaluate(() => window.__testBodyDragActive())), 'a drag that starts well away from a small item is not a drag of the item');
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await state();
  check(!after || Math.hypot(after.x - before.x, after.y - before.y) < 0.01, 'and the item did not move');
}

await finish(browser, { pass: pass && errors.length === 0, label: '#4410: a press beside a small selected item grabs it; one well away does not', errors });
