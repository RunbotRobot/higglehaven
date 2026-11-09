// #3334: on a phone the fly button (bird) covered part of the fly-down arrow.
// Shop spawns the player in flight, so both are on screen right after the
// world loads. Asserts the real laid-out boxes of #shop-fly-btn and every
// #shop-vertical-controls button never intersect at 390x844.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Fly Button Overlap Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 844 });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 20000 });
await page.waitForSelector('body.shop-flying #shop-vertical-controls.visible', { timeout: 10000 });
await page.waitForTimeout(500);

const boxes = await page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  return {
    fly: r(document.getElementById('shop-fly-btn')),
    buttons: [...document.querySelectorAll('#shop-vertical-controls button')].map(r),
  };
});
console.log('fly button box:', JSON.stringify(boxes.fly));
console.log('vertical control boxes:', JSON.stringify(boxes.buttons));
const intersects = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
const overlaps = boxes.buttons.filter((b) => intersects(boxes.fly, b)).length;
console.log('vertical buttons overlapping the fly button (should be 0):', overlaps);

const pass = boxes.buttons.length >= 2 && overlaps === 0 && errors.length === 0;
await finish(browser, {
  pass,
  label: 'Shop HUD (#3334): the fly button never overlaps the fly up/down arrows on a phone',
  errors,
});
