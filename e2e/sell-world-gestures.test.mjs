// #3756 (a regression from #3669, part of #3648): a seller could not move in Sell's showroom
// on a phone. Two things met. The sticks went everywhere (#3650) and the touch gestures that
// replace them are listened for only while movement is switched on; and since Sell lands on the
// showroom with nothing over it (#3712) the seller sheet's class never changes, so the world
// view, which started out believing the sheet was open, never switched movement on.
// At phone size with real touch input (Chrome DevTools Protocol touch events, pointerType
// "touch"), on arrival in Sell with no sheet: a drag on the left half walks the avatar, a
// drag on the right half turns the camera, a double-tap takes off. Removing a control in one
// mode must never strand another again.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Sell Gestures Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// openProducts: false: land on the showroom with nothing over it, as a returning seller does.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true, openProducts: false });
await page.waitForFunction(() => window.__sellWorldViewActive?.() === true, null, { timeout: 30000 });
await page.waitForTimeout(1500);
console.log('on entry: seller sheet shown =', await page.locator('#seller-modal.visible').count(), '; shop-ready =', await page.evaluate(() => document.body.classList.contains('shop-ready')));
check((await page.locator('#seller-modal.visible').count()) === 0, 'Sell lands on the showroom with no sheet over it');
check(await page.evaluate(() => document.body.classList.contains('shop-ready')), 'movement is on in the showroom on arrival (body.shop-ready)');

const cdp = await page.context().newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
});
const wait = (ms) => page.waitForTimeout(ms);
const doubleTap = () => Promise.all([
  touch('touchStart', [{ id: 1, x: 200, y: 300 }]),
  touch('touchEnd', []),
  touch('touchStart', [{ id: 1, x: 202, y: 301 }]),
  touch('touchEnd', []),
]);
const pos = () => page.evaluate(() => window.__testShopAvatarPosition());
const view = () => page.evaluate(() => window.__testShopCameraView());
const flying = () => page.evaluate(() => document.body.classList.contains('shop-flying'));

// A drag on the left half walks.
const start = await pos();
await touch('touchStart', [{ id: 1, x: 100, y: 560 }]);
await touch('touchMove', [{ id: 1, x: 100, y: 520 }]);
await touch('touchMove', [{ id: 1, x: 100, y: 490 }]);
await wait(1000);
await touch('touchEnd', []);
await wait(300);
const walked = await pos();
const walkedM = Math.hypot(walked.x - start.x, walked.y - start.y);
console.log('walked', walkedM.toFixed(2), 'm');
check(walkedM > 0.3, `a drag on the left half walks the avatar in Sell (moved ${walkedM.toFixed(2)} m)`);

// A drag on the right half looks.
const viewBefore = JSON.stringify(await view());
await touch('touchStart', [{ id: 1, x: 300, y: 600 }]);
await touch('touchMove', [{ id: 1, x: 330, y: 600 }]);
await touch('touchMove', [{ id: 1, x: 360, y: 600 }]);
await wait(800);
await touch('touchEnd', []);
await wait(300);
check(JSON.stringify(await view()) !== viewBefore, 'a drag on the right half turns the camera in Sell');

// A double-tap takes off.
await doubleTap();
await wait(500);
check(await flying(), 'a double-tap takes off in Sell');

await finish(browser, { pass: pass && errors.length === 0, label: '#3756: Sell takes the same touch gestures as Shop', errors });
