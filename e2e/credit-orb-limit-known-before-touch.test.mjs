// #3441: the app knows the orb limit before the touch. After the limit is
// reached, touching an orb leaves it in place (no pop, no toast, no collect
// request) and shows the limit with the time it lifts; and two notices shown
// at once are both readable, neither covering the other.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Credit Orb Standing Tester';
const LANDLET_ID = `credit-orb-standing-e2e-${Date.now()}`;
const ORB_X = 2;
const ORB_Y = -1;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 844 });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const orbId = await seedCreditOrbAsAdmin(LANDLET_ID, { x: ORB_X, y: ORB_Y });

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { body: { landlets } } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.landletId === LANDLET_ID);

// Reach the limit: 20 attempts (404s count) against a bogus orb id.
for (let i = 0; i < 20; i += 1) await fetchJson('/api/credit-orbs/not-a-real-orb/collect', { method: 'POST' });
const standing = (await fetchJson('/api/credit-orbs/standing')).body.standing;
console.log('server standing at the limit (remaining should be 0):', JSON.stringify(standing));

// Free the avatar from the spawn orbit, ground it, load the landlet (its orb
// list and the standing arrive with it), then step onto the orb.
const joy = await page.locator('#shop-move-joystick').boundingBox();
const jx = joy.x + joy.width / 2;
const jy = joy.y + joy.height / 2;
await page.mouse.move(jx, jy);
await page.mouse.down();
await page.mouse.move(jx + 25, jy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);
await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y, 0]);
await page.waitForFunction((id) => window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 10000 });
// The landlet may already have loaded (and read the standing) before the limit
// was reached above; leave and come back so its orbs, and the standing with
// them, are read again now that the person is at the limit.
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x + 3000, y + 3000, 0);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForFunction((id) => !window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 10000 });
await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y, 0]);
await page.waitForFunction((id) => window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 10000 });
await page.waitForTimeout(800); // the standing read lands just after the orb list

let collectRequests = 0;
await page.route('**/api/credit-orbs/*/collect', (route) => { collectRequests += 1; route.continue(); });
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x + ORB_X, myLandlet.center.y + ORB_Y]);
await page.waitForSelector('#shop-credit-orb-rate-limit-notice.visible', { timeout: 5000 });
await page.waitForTimeout(800);
const noticeText = await page.textContent('#shop-credit-orb-rate-limit-notice .shop-notice-text');
const orbStayed = (await page.evaluate(() => window.__testActiveCreditOrbIds())).includes(orbId);
const popEffects = await page.evaluate(() => window.__testActiveCreditOrbPopEffectCount());
const toastVisible = await page.isVisible('#shop-credit-orb-toast.visible');
console.log('notice:', JSON.stringify(noticeText), '| orb stayed:', orbStayed, '| pop effects:', popEffects, '| toast:', toastVisible, '| collect requests:', collectRequests);
await page.unroute('**/api/credit-orbs/*/collect');

// Two notices at once: both visible, not covering each other, both dismissible.
await page.evaluate(() => {
  document.getElementById('shop-credit-orb-problem-notice').classList.add('visible');
  document.getElementById('shop-credit-orb-problem-notice').style.order = '99';
});
await page.waitForTimeout(200);
const boxes = await page.evaluate(() => {
  const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right }; };
  return { limit: r('shop-credit-orb-rate-limit-notice'), problem: r('shop-credit-orb-problem-notice'), vh: window.innerHeight };
});
const apart = boxes.limit.b <= boxes.problem.t + 0.5 || boxes.problem.b <= boxes.limit.t + 0.5;
const onScreen = boxes.limit.t >= 0 && boxes.problem.t >= 0 && boxes.limit.b <= boxes.vh && boxes.problem.b <= boxes.vh;
console.log('two notices do not overlap (should be true):', apart, '| both on screen:', onScreen, JSON.stringify(boxes));
await page.click('#shop-credit-orb-problem-notice .shop-notice-dismiss-btn');
const limitStillThere = await page.isVisible('#shop-credit-orb-rate-limit-notice.visible');
console.log('dismissing one leaves the other shown (should be true):', limitStillThere);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));
const pass = standing.remaining === 0
  && orbStayed && popEffects === 0 && !toastVisible && collectRequests === 0
  && /Try again/.test(noticeText) && !/back where it was/.test(noticeText)
  && apart && onScreen && limitStillThere
  && unexpectedErrors.length === 0;
await finish(browser, { pass, label: '#3441: an orb touched at the limit stays put and says why; stacked notices stay readable', errors });
