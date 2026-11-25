// #4105 (part of #3539; the owner chose the edge slide after flying three ways, #4102): flight is level
// and a thumb sliding up or down along the right edge of the screen rises or sinks. The view's pitch no
// longer climbs, the path no longer tilts and the body no longer tips with the view. On a keyboard,
// Page Up rises and Page Down sinks. The limits are felt and said once: the top of the sky, the lowest
// hover (no landing by itself). The automated mouse counts as one finger (src/shop/flightMovement.js).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Flight Height Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
// Nothing explains itself unasked (#4179): the first flight says nothing about height.
await page.waitForTimeout(1500);
check(!/right edge|Page Up/.test(await page.evaluate(() => document.getElementById('shop-status').textContent)), 'the first flight does not explain how to change height');
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 15000 });
// Land the spawn flight, then take off, so the start is the ordinary hover.
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForFunction(() => window.__testShopFlightState() === 'grounded', null, { timeout: 15000 });
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForFunction(() => window.__testShopFlightState() === 'flying', null, { timeout: 15000 });
await page.waitForTimeout(500);

const z = () => page.evaluate(() => window.__testShopAvatarPosition().z);
const pitch = (rad) => page.evaluate((r) => window.__testSetShopPitch(r), rad);
const walk = async (ms) => { await page.keyboard.down('KeyW'); await page.waitForTimeout(ms); await page.keyboard.up('KeyW'); };

// Level flight: a view pitched down or up does not change height while walking, and the body keeps its lean.
for (const rad of [-0.9, 0.9, 0]) {
  await pitch(rad);
  const z0 = await z();
  await walk(1000);
  check(Math.abs((await z()) - z0) < 0.05, `a view at ${rad} rad flies level`);
}
await pitch(-0.5);
await page.waitForTimeout(900);
const tiltDown = await page.evaluate(() => window.__shopAvatarOrientation.pitchRad);
await pitch(0.5);
await page.waitForTimeout(900);
const tiltUp = await page.evaluate(() => window.__shopAvatarOrientation.pitchRad);
check(Math.abs(tiltUp - tiltDown) < 0.05, `the body does not tip with the view (${tiltDown.toFixed(2)} vs ${tiltUp.toFixed(2)} rad)`);
await pitch(0);

// The edge slide.
const edgeX = 385;
const slide = async (fromY, toY, ms = 900) => {
  await page.mouse.move(edgeX, fromY);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(edgeX, fromY + ((toY - fromY) * i) / 6);
  await page.waitForTimeout(ms);
  await page.mouse.up();
};
const z0 = await z();
await slide(500, 400);
const z1 = await z();
check(z1 > z0 + 0.5, `sliding up along the right edge rises (${z0.toFixed(2)} -> ${z1.toFixed(2)})`);
await slide(400, 500, 1400);
const z2 = await z();
check(z2 < z1 - 0.5, `sliding down sinks (${z1.toFixed(2)} -> ${z2.toFixed(2)})`);
check((await page.evaluate(() => window.__testShopFlightHeight().rate)) === 0, 'letting go holds the height');
await page.waitForTimeout(500);
check(Math.abs((await z()) - z2) < 0.05, 'with no gesture the height is held');

// A drag that starts just inside the look half is the view, not height.
const z3 = await z();
await page.mouse.move(300, 500);
await page.mouse.down();
for (let i = 1; i <= 6; i += 1) await page.mouse.move(300, 500 - i * 15);
await page.waitForTimeout(500);
await page.mouse.up();
check(Math.abs((await z()) - z3) < 0.05, 'a drag on the look half does not change height');

// Keyboard: Page Up rises, Page Down sinks.
const k0 = await z();
await page.keyboard.down('PageUp');
await page.waitForTimeout(900);
await page.keyboard.up('PageUp');
const k1 = await z();
check(k1 > k0 + 0.5, `Page Up rises (${k0.toFixed(2)} -> ${k1.toFixed(2)})`);
await page.keyboard.down('PageDown');
await page.waitForTimeout(900);
await page.keyboard.up('PageDown');
check((await z()) < k1 - 0.5, 'Page Down sinks');

// The top of the sky: it levels off, stays, and says so in plain words.
await page.keyboard.down('PageUp');
const sawTop = await page.waitForFunction(() => document.getElementById('shop-status').textContent.includes('top of the sky'), null, { timeout: 40000 }).then(() => true, () => false);
await page.keyboard.up('PageUp');
check(sawTop, 'the top of the sky is said in plain words');
await page.waitForTimeout(500);
const top1 = await z();
await page.keyboard.down('PageUp');
await page.waitForTimeout(1500);
await page.keyboard.up('PageUp');
check(Math.abs((await z()) - top1) < 0.05, 'it rests at the top of the sky and does not bounce');

// The bottom: sinks to the lowest hover, says so, does not land.
await page.keyboard.down('PageDown');
const sawLow = await page.waitForFunction(() => document.getElementById('shop-status').textContent.includes('as low as you can fly'), null, { timeout: 60000 }).then(() => true, () => false);
await page.keyboard.up('PageDown');
check(sawLow, 'the lowest hover is said in plain words');
check(await page.evaluate(() => document.body.classList.contains('shop-flying')), 'sinking to the lowest hover does not land by itself');
check((await page.locator('#shop-up-btn, #shop-down-btn, #shop-vertical-controls').count()) === 0, 'there are no up and down arrows');

// Nothing is left of the comparison: the address and the stored choice do nothing.
await page.evaluate(() => window.localStorage.setItem('higglehaven.flightHeight', 'c'));
await page.goto(`${process.env.E2E_BASE_URL || 'http://127.0.0.1:8787'}/?height=b`, { waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
check((await page.evaluate(() => window.localStorage.getItem('higglehaven.flightHeight'))) === null, 'the stored choice from the comparison is cleared once');

await finish(browser, { pass: pass && errors.length === 0, label: '#4105: flight is level; the edge slide and Page Up/Down change height', errors });
