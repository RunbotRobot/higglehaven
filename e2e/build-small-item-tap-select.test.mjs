// #4489: selecting by tap. A tap has to land on an item to select it, and a small or far-off item is a few pixels wide
// on a phone (found live: a tap 3 px off a brick selected nothing). A tap that hits nothing now selects the nearest SMALL
// item whose middle is within 22 px; one well away from it still selects nothing. 390x844, a mouse standing in for a
// finger.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Small Item Tap Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const selected = () => page.evaluate(() => !!window.__testSelectedItemState());

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).first().click();
await page.waitForTimeout(300);
await page.mouse.click(195, 430);
await page.waitForTimeout(1000);

// Zoom out until the whole item is small on screen (measured while it is selected).
let core = await page.evaluate(() => window.__testItemScreenCore());
for (let i = 0; i < 14 && core && core.radius > 12; i++) {
  await page.mouse.move(330, 740);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(450);
  core = await page.evaluate(() => window.__testItemScreenCore());
}
check(core && core.radius < 16, `the item is small on screen (radius ${core?.radius?.toFixed(1)} px)`);

// Let go of it with a tap far from it, then tap beside it.
await page.mouse.click(40, 760);
await page.waitForTimeout(400);
check(!(await selected()), 'a tap far from the item leaves nothing selected');
const spot = (await page.evaluate(() => window.__testProductScreenPositions()))[0];
console.log('item at', Math.round(spot.x), Math.round(spot.y));

// 14 px beside it, on no item (a tree is wider than 14 px only up close).
await page.mouse.click(spot.x + 14, spot.y + 6);
await page.waitForTimeout(500);
check(await selected(), 'a tap 15 px beside a small item selects it');

await page.mouse.click(40, 760);
await page.waitForTimeout(400);
await page.mouse.click(spot.x + 70, spot.y + 30);
await page.waitForTimeout(500);
check(!(await selected()), 'a tap 75 px from it selects nothing');

await finish(browser, { pass: pass && errors.length === 0, label: '#4489: a tap beside a small item selects it; a tap well away does not', errors });
