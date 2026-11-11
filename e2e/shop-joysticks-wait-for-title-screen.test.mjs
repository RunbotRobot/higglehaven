// #3442: the joysticks used to show while the higglehaven title screen
// (#loading-screen) was still up. Two causes: src/shop/mode.js marked them
// visible at the top of enterShopMode, long before the fly button and vertical
// controls, and the title screen (z-index 15) sat *below* every .shop-ui
// element (z-index 16), so whatever was marked visible early painted on top of
// it. The owner wants the whole HUD to arrive together, once the title screen
// has gone.
//
// At phone width (390 px) this holds the Shop world's catalog fetch open, so
// the title screen stays up for as long as we like, and asserts that
//   - neither joystick is hit-testable at its own position (the title screen
//     is what is on top there) and neither is marked visible;
// then releases the fetch and asserts that, once the title screen has faded,
//   - both joysticks and the fly button are visible, and
//   - the joysticks never appeared in a frame where the fly button was not
//     (a per-frame recorder installed before any app code runs).
import { chromium } from 'playwright';
import { chooseIdentity, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const LABEL = 'Shop Joystick Title Screen Builder';

const browser = await chromium.launch({ executablePath: CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept(LABEL);
  else await dialog.accept();
});

// Recorded in the page, before any app script runs.
await page.addInitScript(() => {
  window.__hud = { joystickWithoutFly: false, joystickShownOverSplash: false };
  const shown = (el) => el && getComputedStyle(el).display !== 'none';
  const tick = () => {
    const move = document.getElementById('shop-move-joystick');
    const look = document.getElementById('shop-look-joystick');
    const fly = document.getElementById('shop-fly-btn');
    const splash = document.getElementById('loading-screen');
    for (const el of [move, look]) {
      if (!shown(el)) continue;
      if (!shown(fly)) window.__hud.joystickWithoutFly = true;
      const splashUp = splash && getComputedStyle(splash).display !== 'none'
        && parseFloat(getComputedStyle(splash).opacity) > 0.5;
      if (splashUp) {
        const rect = el.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (top && (top === el || el.contains(top))) window.__hud.joystickShownOverSplash = true;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
// A real session, so the reload below lands straight in Shop.
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });

let release;
const held = new Promise((resolve) => { release = resolve; });
await page.route('**/api/catalog?*', async (route) => {
  await held;
  await route.continue();
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const during = await page.evaluate(() => {
  const splash = document.getElementById('loading-screen');
  const out = {
    splashUp: !!splash && getComputedStyle(splash).display !== 'none'
      && !splash.classList.contains('loading-screen-hidden'),
    joysticks: {},
  };
  for (const id of ['shop-move-joystick', 'shop-look-joystick']) {
    const el = document.getElementById(id);
    const rect = el.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    out.joysticks[id] = {
      visibleClass: el.classList.contains('visible'),
      display: getComputedStyle(el).display,
      hitTestedOnTop: !!top && (top === el || el.contains(top)),
    };
  }
  return out;
});
console.log('title screen up while the catalog is held (should be true):', during.splashUp);
console.log('joysticks while the title screen is up:', JSON.stringify(during.joysticks));

release();
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 30000 });
await page.waitForFunction(() => {
  const splash = document.getElementById('loading-screen');
  return !splash || getComputedStyle(splash).display === 'none';
}, null, { timeout: 15000 });
await page.waitForTimeout(300);

const after = await page.evaluate(() => {
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
  return {
    move: shown('shop-move-joystick'),
    look: shown('shop-look-joystick'),
    fly: shown('shop-fly-btn'),
    hud: window.__hud,
  };
});
console.log('after the title screen has gone:', JSON.stringify(after));

const duringOk = during.splashUp
  && Object.values(during.joysticks).every((j) => !j.visibleClass && j.display === 'none' && !j.hitTestedOnTop);
const afterOk = after.move && after.look && after.fly
  && !after.hud.joystickWithoutFly && !after.hud.joystickShownOverSplash;

await finish(browser, {
  pass: duringOk && afterOk && errors.length === 0,
  label: 'Shop HUD (#3442): the joysticks wait for the title screen and arrive with the other controls',
  errors,
});
