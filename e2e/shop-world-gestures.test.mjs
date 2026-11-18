// #3650, #3749 (part of #3648, the bud): moving through the world by touching it. At
// phone size with real touch input (Chrome DevTools Protocol touch events, so
// pointerType is "touch"): a drag that starts on the left half walks, a drag that
// starts on the right half looks (alone, with nothing else down, and together with a
// walking thumb), a double-tap takes off and lands, a tap that does not move walks
// nowhere, and there are no on-screen sticks or fly button any more.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'World Gestures Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 15000 });

check(await page.evaluate(() => !document.getElementById('shop-move-joystick') && !document.getElementById('shop-look-joystick') && !document.getElementById('shop-fly-btn')),
  'the sticks and the fly button are not on the page');

const cdp = await page.context().newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
});
const wait = (ms) => page.waitForTimeout(ms);
// Both taps are sent without waiting for a reply in between, so the gap between
// them is the page's, not the test machine's (a slow CI runner can take longer
// than the double-tap window to answer each of four round trips).
const doubleTap = () => Promise.all([
  touch('touchStart', [{ id: 1, x: 200, y: 300 }]),
  touch('touchEnd', []),
  touch('touchStart', [{ id: 1, x: 202, y: 301 }]),
  touch('touchEnd', []),
]);
const pos = () => page.evaluate(() => window.__testShopAvatarPosition());
const flying = () => page.evaluate(() => document.body.classList.contains('shop-flying'));
const view = () => page.evaluate(() => window.__testShopCameraView());

// Land the spawn's own flight so walking is ground walking.
if (await flying()) {
  await page.evaluate(() => window.__testToggleShopFlight());
  await wait(2600);
}
check(!(await flying()), 'grounded before walking');

// A drag on the left half walks: put a finger down on open ground, drag it up the screen, hold.
const start = await pos();
await touch('touchStart', [{ id: 1, x: 100, y: 560 }]);
await touch('touchMove', [{ id: 1, x: 100, y: 520 }]);
await touch('touchMove', [{ id: 1, x: 100, y: 490 }]);
await wait(1200);
await touch('touchEnd', []);
await wait(300);
const walked = await pos();
const walkedM = Math.hypot(walked.x - start.x, walked.y - start.y);
console.log('walked', walkedM.toFixed(2), 'm');
check(walkedM > 1, `a drag walks the avatar (moved ${walkedM.toFixed(2)} m)`);
// ... and stops when the finger lifts.
await wait(600);
const rested = await pos();
check(Math.hypot(rested.x - walked.x, rested.y - walked.y) < 0.6, 'the avatar stops when the finger lifts');

// A tap that does not move walks nowhere.
const beforeTap = await pos();
await touch('touchStart', [{ id: 1, x: 100, y: 300 }]);
await wait(60);
await touch('touchEnd', []);
await wait(500);
const afterTap = await pos();
check(Math.hypot(afterTap.x - beforeTap.x, afterTap.y - beforeTap.y) < 0.05, 'a tap that does not move does not walk');

// A drag on the right half looks, ALONE: nothing else is down, the avatar does not walk.
const beforeLook = await pos();
const viewBefore = JSON.stringify(await view());
await touch('touchStart', [{ id: 1, x: 300, y: 600 }]);
await touch('touchMove', [{ id: 1, x: 330, y: 600 }]);
await touch('touchMove', [{ id: 1, x: 360, y: 600 }]);
await wait(900);
await touch('touchEnd', []);
await wait(300);
const viewAfter = JSON.stringify(await view());
const afterLook = await pos();
check(viewBefore !== viewAfter, 'one finger dragging on the right half looks (the camera turned)');
check(Math.hypot(afterLook.x - beforeLook.x, afterLook.y - beforeLook.y) < 0.3, 'looking alone does not walk the avatar');

// Both thumbs at once: left walks, right looks, whichever went down first.
const beforeBoth = await pos();
const viewBeforeBoth = JSON.stringify(await view());
await touch('touchStart', [{ id: 2, x: 300, y: 600 }]);
await touch('touchStart', [{ id: 2, x: 300, y: 600 }, { id: 1, x: 100, y: 600 }]);
await touch('touchMove', [{ id: 2, x: 340, y: 600 }, { id: 1, x: 100, y: 560 }]);
await touch('touchMove', [{ id: 2, x: 360, y: 600 }, { id: 1, x: 100, y: 520 }]);
await wait(900);
await touch('touchEnd', []);
await wait(300);
const afterBoth = await pos();
check(JSON.stringify(await view()) !== viewBeforeBoth, 'both thumbs: the right one looks');
check(Math.hypot(afterBoth.x - beforeBoth.x, afterBoth.y - beforeBoth.y) > 0.5, 'both thumbs: the left one walks');

console.log('fingers still tracked after the look gesture (should be 0):', await page.evaluate(() => window.__testWorldGestureFingers()));
check((await page.evaluate(() => window.__testWorldGestureFingers())) === 0, 'every finger is released after the gestures');

// A double-tap takes off, and another lands.
await doubleTap();
await wait(400);
check(await flying(), 'a double-tap takes off');
await wait(1500);
await doubleTap();
await wait(400);
check(!(await flying()), 'another double-tap lands');

await finish(browser, { pass: pass && errors.length === 0, label: '#3650, #3749: left half walks, right half looks (alone and together), a double-tap flies, no sticks or fly button', errors });
