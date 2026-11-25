// #3831 (part of #3539): a person's mouse looks around in Shop. Hold the left button on the
// world and drag: horizontally turns, vertically looks up and down, from anywhere on the screen
// (one button, one meaning, so no walking half), and the avatar does not walk. A click that
// does not move turns nothing and a double click does not fly.
//
// An automated browser reports navigator.webdriver, which src/shop/flightMovement.js treats as
// "the mouse is a finger" for the suite's other tests; window.__testRealMouse switches that
// off, so these are real mouse events handled as a person's mouse is.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Mouse Look Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 1280, height: 800 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 15000 });
await page.evaluate(() => { window.__testRealMouse = true; });

const wait = (ms) => page.waitForTimeout(ms);
const pos = () => page.evaluate(() => window.__testShopAvatarPosition());
const view = async () => JSON.stringify(await page.evaluate(() => window.__testShopCameraView()));
const flying = () => page.evaluate(() => document.body.classList.contains('shop-flying'));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Land the spawn's own flight, and let it come to rest.
if (await flying()) {
  await page.evaluate(() => window.__testToggleShopFlight());
  await wait(2600);
}
check(!(await flying()), 'grounded before the mouse is used');
// (flake, area 14) The fixed wait above is a guess at how long the landing takes; on a slow runner the avatar was
// still settling at the first drag (the first attempt failed "does not walk" on CI, the retry passed). Wait until
// it has stopped moving instead of counting seconds.
for (let i = 0, last = await pos(); i < 60; i += 1) {
  await wait(400);
  const now = await pos();
  const still = Math.hypot(now.x - last.x, now.y - last.y, (now.z ?? 0) - (last.z ?? 0)) < 0.02;
  last = now;
  if (still) break;
}

async function drag(fromX, fromY, toX, toY) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move((fromX + toX) / 2, (fromY + toY) / 2, { steps: 3 });
  await page.mouse.move(toX, toY, { steps: 3 });
  await wait(900); // held at the end, as a hand rests
  await page.mouse.up();
  await wait(400);
}

// A drag turns the view, from the right half and from the left half alike, and does not walk.
for (const [name, x] of [['right half', 900], ['left half', 300]]) {
  const before = await view();
  const where = await pos();
  await drag(x, 500, x + 160, 500);
  check(before !== await view(), `a mouse drag from the ${name} turns the view`);
  const walked = dist(where, await pos());
  check(walked < 0.3, `a mouse drag from the ${name} does not walk the avatar (it moved ${walked.toFixed(2)} m, from ${JSON.stringify(where)})`);
}

// A vertical drag looks up or down. The spawn leaves the camera tilted down as far as it goes, so
// the drag that has something to do is the one that looks up.
const beforePitch = await view();
await drag(700, 560, 700, 400);
check(beforePitch !== await view(), 'a mouse drag up looks up (the view changed)');

// A click that does not move turns nothing, and a double click does not fly.
const beforeClick = await view();
await page.mouse.click(640, 500);
await wait(150);
await page.mouse.dblclick(640, 500);
await wait(600);
check(beforeClick === await view(), 'a click that does not move leaves the view where it was');
check(!(await flying()), 'a double click does not take off');

// Only the left button looks.
const beforeRight = await view();
await page.mouse.move(700, 500);
await page.mouse.down({ button: 'right' });
await page.mouse.move(860, 500, { steps: 6 });
await page.mouse.up({ button: 'right' });
await wait(400);
check(beforeRight === await view(), 'dragging with the right button does not turn the view');

check((await page.evaluate(() => window.__testWorldGestureFingers())) === 0, 'nothing is left held after the gestures');

await finish(browser, { pass: pass && errors.length === 0, label: '#3831: a real mouse drag looks around (either half, and up), a click does not, a double click does not fly, the right button does nothing', errors });
