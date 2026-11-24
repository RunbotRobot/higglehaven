// #4102 (part of #3539): the three ways of changing height while flying, to fly and compare.
// `?height=a|b|c` (remembered in the browser, `?height=off` forgets it) makes flight level and gives
// height to one gesture: A slides a thumb along the right edge, B double-taps and holds and slides, C
// pinches with two fingers on one half. With nothing chosen the page is today's (the view's pitch
// climbs, flight-by-view.test.mjs) and nothing here is on. The automated mouse counts as one finger
// (src/shop/flightMovement.js), which is enough for A and B; the pinch is two synthetic touch
// pointers on the world canvas.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const LABEL = 'Flight Height Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
check((await page.evaluate(() => window.__testShopFlightHeight())) === null, 'nothing chosen: no flight-height option is on');

const z = () => page.evaluate(() => window.__testShopAvatarPosition().z);
const pitch = (rad) => page.evaluate((r) => window.__testSetShopPitch(r), rad);
const flightState = () => page.evaluate(() => window.__testShopFlightState());
async function openWith(query) {
  await page.goto(`${BASE_URL}${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.shop-ready', { timeout: 20000 });
}
async function hover() {
  // Land the spawn flight, then take off, so the start is the ordinary hover.
  if ((await flightState()) !== 'grounded') {
    await page.evaluate(() => window.__testToggleShopFlight());
    await page.waitForFunction(() => window.__testShopFlightState() === 'grounded', null, { timeout: 15000 });
  }
  await page.evaluate(() => window.__testToggleShopFlight());
  await page.waitForFunction(() => window.__testShopFlightState() === 'flying', null, { timeout: 15000 });
  await page.waitForTimeout(500);
}
const WORDS = {
  a: /right edge/,
  b: /Double-tap, keep your finger down/,
  c: /two fingers together/,
};

// Level flight is common to all three: a view pitched straight down does not descend.
async function levelFlight(mode) {
  await pitch(-0.9);
  const z0 = await z();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  check(Math.abs((await z()) - z0) < 0.05, `${mode}: looking down while moving flies level (${z0.toFixed(2)} -> ${(await z()).toFixed(2)})`);
  await pitch(0.9);
  const z1 = await z();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  check(Math.abs((await z()) - z1) < 0.05, `${mode}: looking up while moving flies level`);
  await pitch(0);
}

async function riseAndSink(mode, rise, sink) {
  const z0 = await z();
  await rise();
  const z1 = await z();
  check(z1 > z0 + 0.5, `${mode}: the gesture rises (${z0.toFixed(2)} -> ${z1.toFixed(2)})`);
  await sink();
  const z2 = await z();
  check(z2 < z1 - 0.5, `${mode}: the opposite gesture sinks (${z1.toFixed(2)} -> ${z2.toFixed(2)})`);
  const rate = await page.evaluate(() => window.__testShopFlightHeight().rate);
  check(rate === 0, `${mode}: letting go holds the height`);
}

// A: slide a thumb along the right edge.
await openWith('?height=a');
check((await page.evaluate(() => window.__testShopFlightHeight().mode)) === 'a', 'A: ?height=a turns option A on');
check(await page.waitForFunction((re) => new RegExp(re).test(document.getElementById('shop-status').textContent), WORDS.a.source, { timeout: 8000 }).then(() => true, () => false), 'A: the first flight says the gesture in plain words');
await hover();
await levelFlight('A');
const edgeX = 385;
const slide = async (fromY, toY, ms = 900) => {
  await page.mouse.move(edgeX, fromY);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(edgeX, fromY + ((toY - fromY) * i) / 6);
  await page.waitForTimeout(ms);
  await page.mouse.up();
};
await riseAndSink('A', () => slide(500, 400), () => slide(400, 500, 1400));

// Remembered: a fresh load of the plain address keeps the option until it is cleared.
await openWith('');
check((await page.evaluate(() => window.__testShopFlightHeight()?.mode)) === 'a', 'the choice is remembered for this browser');

// B: double-tap, keep the finger down, slide.
await openWith('?height=b');
check((await page.evaluate(() => window.__testShopFlightHeight().mode)) === 'b', 'B: ?height=b turns option B on');
await hover();
await levelFlight('B');
const holdSlide = async (toDy, ms = 900) => {
  await page.mouse.move(200, 600);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(202, 602);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(202, 602 + (toDy * i) / 6);
  await page.waitForTimeout(ms);
  await page.mouse.up();
};
await riseAndSink('B', () => holdSlide(-100), () => holdSlide(100, 1400));
// A plain double-tap still lands.
await page.mouse.click(200, 600);
await page.mouse.click(202, 601);
check(await page.waitForFunction(() => ['landing', 'grounded'].includes(window.__testShopFlightState()), null, { timeout: 5000 }).then(() => true, () => false), 'B: a plain double-tap still lands');

// C: pinch with two fingers on one half of the screen.
await openWith('?height=c');
check((await page.evaluate(() => window.__testShopFlightHeight().mode)) === 'c', 'C: ?height=c turns option C on');
await hover();
await levelFlight('C');
const pinch = (fromGap, toGap, ms = 900) => page.evaluate(async ([from, to, wait]) => {
  const canvas = document.querySelector('canvas');
  const fire = (type, id, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 31 }));
  const cx = 290;
  fire('pointerdown', 31, cx - from / 2, 500);
  fire('pointerdown', 32, cx + from / 2, 500);
  for (let i = 1; i <= 6; i += 1) {
    const gap = from + ((to - from) * i) / 6;
    fire('pointermove', 31, cx - gap / 2, 500);
    fire('pointermove', 32, cx + gap / 2, 500);
  }
  await new Promise((resolve) => setTimeout(resolve, wait));
  fire('pointerup', 31, cx - to / 2, 500);
  fire('pointerup', 32, cx + to / 2, 500);
}, [fromGap, toGap, ms]);
await riseAndSink('C', () => pinch(160, 40), () => pinch(40, 160, 1400));

// Cleared: ?height=off puts today's behaviour back.
await openWith('?height=off');
check((await page.evaluate(() => window.__testShopFlightHeight())) === null, '?height=off turns the option off');
await openWith('');
check((await page.evaluate(() => window.__testShopFlightHeight())) === null, 'and it stays off');

// The pinch is two synthetic touch pointers the browser has never seen, and a three.js control listening
// on the same canvas asks the browser to capture them (and to release them): those two refusals are the
// synthetic pointers', not the page's, and are the only errors set aside.
const realErrors = errors.filter((message) => !/(set|release)PointerCapture' on 'Element': No active pointer/.test(message));
await finish(browser, { pass: pass && realErrors.length === 0, label: '#4102: flight height options a, b and c; off by default', errors: realErrors });
