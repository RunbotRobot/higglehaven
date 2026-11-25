// #4174 (owner, 2026-11-24: "I would like orbs to fade into view instead of popping"): an orb that loads as a
// landlet comes into range is not drawn at once; it fades in through the arrival fog (src/shop/creditOrbArrival.js,
// the same fog and dissolve a landlet's products use), at most a few at a time, and settles. The orb a person
// touches mid-fade still pops on contact (creditOrbArrival.test.js; the credit-orb-* e2e files). Leaving range is
// covered by the unit tests. Read through window.__testCreditOrbFadeStats and
// window.__testActiveCreditOrbIds, never by pixels.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox } from './helpers.mjs';

const LABEL = 'Credit Orb Fog Tester';
const LANDLET_ID = `credit-orb-fog-e2e-${Date.now()}`;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
// The world is small, so the orbs load as Shop opens: the watcher is installed before any page script runs and polls
// every frame (no round trip can hide the fade, which is under a second) from the moment the hooks exist.
const installWatcher = () => {
  window.__orbFadeSeen = { maxActive: 0, orbIdsSeen: 0 };
  (function poll() {
    if (window.__testCreditOrbFadeStats && window.__testActiveCreditOrbIds) {
      const stats = window.__testCreditOrbFadeStats();
      window.__orbFadeSeen.maxActive = Math.max(window.__orbFadeSeen.maxActive, stats.active);
      window.__orbFadeSeen.orbIdsSeen = Math.max(window.__orbFadeSeen.orbIdsSeen, window.__testActiveCreditOrbIds().length);
    }
    requestAnimationFrame(poll);
  }());
};
await page.evaluate(installWatcher); // the page is already open when launchPage returns
await page.addInitScript(installWatcher); // and again if a later navigation reloads it
await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
for (let i = 0; i < 3; i += 1) await seedCreditOrbAsAdmin(LANDLET_ID, { x: -6 + i * 6, y: 4 });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { landlets } = await page.evaluate(async () => (await fetch('/api/landlets?limit=100')).json());
const landlet = landlets.find((l) => l.landletId === LANDLET_ID);

// Free the avatar from the spawn orbit, as the other orb e2e files do, then stand it over the landlet.
const stick = await shopStickBox(page);
const cx = stick.x + stick.width / 2;
const cy = stick.y + stick.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();

await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, [landlet.center.x, landlet.center.y]);
await page.waitForFunction(() => window.__testActiveCreditOrbIds().length === 3, null, { timeout: 15000 });
await page.waitForTimeout(2500);
const seen = await page.evaluate(() => window.__orbFadeSeen);
const settled = await page.evaluate(() => window.__testCreditOrbFadeStats());
console.log('orbs loaded (should be 3):', seen.orbIdsSeen);
console.log('at least one orb was fading in while it arrived (should be true):', seen.maxActive > 0);
console.log('no orb is still fading or waiting a couple of seconds on (should be {active:0,waiting:0}):', JSON.stringify(settled));

const pass = seen.orbIdsSeen === 3
  && seen.maxActive > 0
  && settled.active === 0 && settled.waiting === 0;
await finish(browser, { pass, label: '#4174: orbs fade in through fog on arrival and nothing is left fading', errors });
