// #3392: an orb pops the instant the avatar's body touches it; the server
// confirms afterwards and a refusal is reversed visibly with the reason.
// Four orbs on one greenbelt landlet, one per server answer, at 390px:
//   A: collect response delayed 2 s  -> pop effect, orb gone and toast shown
//      well before the response arrives
//   B: 404 (someone else got it)     -> reversal puff, plain message, orb stays gone
//   D: no response (network failure) -> orb stays popped through a quiet retry
//      window, then comes back with a plain message
//   C: 429 (the collect limit)       -> orb comes back, the notice shows the numbers
//      (last: a 429 starts a 30 s collecting cooldown)
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Credit Orb Pop Tester';
const LANDLET_ID = `credit-orb-pop-e2e-${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 844 });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const spots = { A: [2, -1], B: [-3, 2], C: [4, 4], D: [-5, -5] };
const orbIds = {};
for (const [key, [x, y]] of Object.entries(spots)) orbIds[key] = await seedCreditOrbAsAdmin(LANDLET_ID, { x, y });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { landlets } = await page.evaluate(async () => (await fetch('/api/landlets?limit=100')).json());
const myLandlet = landlets.find((l) => l.landletId === LANDLET_ID);

// Break the hands-off spawn orbit with a brief real joystick deflection so the
// teleport hook can drive the avatar (same sequence as credit-orb-collect).
const joystick = await page.locator('#shop-move-joystick').boundingBox();
const cx = joystick.x + joystick.width / 2;
const cy = joystick.y + joystick.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Grounded at the landlet centre, and the orbs loaded.
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForFunction((ids) => ids.every((id) => window.__testActiveCreditOrbIds().includes(id)), Object.values(orbIds), { timeout: 15000 });

const touch = (key) => page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y); window.__testForceShopProximityCheck(); },
  [myLandlet.center.x + spots[key][0], myLandlet.center.y + spots[key][1]]);
const awayFromOrbs = () => page.evaluate(([x, y]) => window.__testTeleportShopAvatar(x, y), [myLandlet.center.x + 20, myLandlet.center.y + 20]);
const orbPresent = (key) => page.evaluate((id) => window.__testActiveCreditOrbIds().includes(id), orbIds[key]);
const dismissProblemNotice = async () => {
  if (await page.isVisible('#shop-credit-orb-problem-notice.visible')) await page.click('#shop-credit-orb-problem-notice .shop-notice-dismiss-btn');
};

// ---- A: delayed confirmation --------------------------------------------
let aResponded = false;
await page.route(`**/api/credit-orbs/${orbIds.A}/collect`, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  aResponded = true;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ collected: true }) });
});
await touch('A');
await page.waitForFunction((id) => !window.__testActiveCreditOrbIds().includes(id) && window.__testActiveCreditOrbPopEffectCount() >= 1, orbIds.A, { timeout: 1500 });
const aToastBeforeResponse = await page.isVisible('#shop-credit-orb-toast.visible');
const aPoppedBeforeResponse = !aResponded;
console.log('A: orb popped and toast shown before the delayed response arrived (should be true, true):', aPoppedBeforeResponse, aToastBeforeResponse);
await page.waitForFunction(() => document.getElementById('shop-credit-orb-toast').classList.contains('visible'), null, { timeout: 5000 });
await page.waitForTimeout(2300);
const aStillGone = !(await orbPresent('A'));
const aNoProblem = !(await page.isVisible('#shop-credit-orb-problem-notice.visible'));
console.log('A: confirmed, orb still gone and no problem notice (should be true, true):', aStillGone, aNoProblem);
await awayFromOrbs();

// ---- B: someone else collected it first (404) -----------------------------
await page.route(`**/api/credit-orbs/${orbIds.B}/collect`, (route) => route.fulfill({
  status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'This credit orb is no longer available -- someone else may have already collected it.' }),
}));
await touch('B');
await page.waitForFunction(() => window.__testActiveCreditOrbReversalEffectCount() >= 1, null, { timeout: 3000, polling: 'raf' });
await page.waitForSelector('#shop-credit-orb-problem-notice.visible', { timeout: 3000 });
const bText = await page.textContent('#shop-credit-orb-problem-notice .shop-notice-text');
console.log('B: reversal effect and notice:', bText);
await page.waitForTimeout(600);
const bGone = !(await orbPresent('B'));
const bToastHidden = !(await page.isVisible('#shop-credit-orb-toast.visible'));
console.log('B: orb stays gone, toast withdrawn (should be true, true):', bGone, bToastHidden);
await dismissProblemNotice();
await awayFromOrbs();

// ---- D: no response at all (network failure) ------------------------------
// Runs before C: a 429 starts a 30 s collecting cooldown.
let dRequests = 0;
await page.route(`**/api/credit-orbs/${orbIds.D}/collect`, (route) => { dRequests += 1; route.abort('failed'); });
await touch('D');
await page.waitForFunction((id) => !window.__testActiveCreditOrbIds().includes(id), orbIds.D, { timeout: 1500 });
await page.waitForTimeout(2000);
const dStillPoppedMidRetry = !(await orbPresent('D'));
const dNoNoticeYet = !(await page.isVisible('#shop-credit-orb-problem-notice.visible'));
console.log('D: popped and quietly retrying after 2 s (should be true, true):', dStillPoppedMidRetry, dNoNoticeYet, 'requests so far:', dRequests);
await page.waitForFunction((id) => window.__testActiveCreditOrbIds().includes(id), orbIds.D, { timeout: 8000 });
await page.waitForSelector('#shop-credit-orb-problem-notice.visible', { timeout: 3000 });
const dText = await page.textContent('#shop-credit-orb-problem-notice .shop-notice-text');
const dToastHidden = !(await page.isVisible('#shop-credit-orb-toast.visible'));
const dRequestsAtGiveUp = dRequests;
await page.waitForTimeout(1200);
const dNotRetriggered = dRequests === dRequestsAtGiveUp;
console.log('D: orb returned after the retry window with a plain message; no re-trigger while standing on it:', dText, dToastHidden, dNotRetriggered, 'requests:', dRequests);
await dismissProblemNotice();
await awayFromOrbs();

// ---- C: the collect limit (429) -------------------------------------------
await page.route(`**/api/credit-orbs/${orbIds.C}/collect`, (route) => route.fulfill({
  status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many requests', limit: 20, windowSeconds: 900, retryAfterSeconds: 420 }),
}));
await touch('C');
await page.waitForSelector('#shop-credit-orb-rate-limit-notice.visible', { timeout: 3000 });
const cText = await page.textContent('#shop-credit-orb-rate-limit-notice .shop-notice-text');
await page.waitForFunction((id) => window.__testActiveCreditOrbIds().includes(id), orbIds.C, { timeout: 3000 });
const cToastHidden = !(await page.isVisible('#shop-credit-orb-toast.visible'));
console.log('C: orb came back, notice shows the numbers, toast withdrawn:', cText, cToastHidden);
await page.click('#shop-credit-orb-rate-limit-notice .shop-notice-dismiss-btn');
await awayFromOrbs();

const aOk = aPoppedBeforeResponse && aToastBeforeResponse && aStillGone && aNoProblem;
const bOk = /Someone else collected that orb/.test(bText) && bGone && bToastHidden;
const dOk = dStillPoppedMidRetry && dNoNoticeYet && dRequests >= 2 && /Couldn't collect that orb/.test(dText) && dToastHidden && dNotRetriggered;
const cOk = /up to 20 orbs every 15 minutes/.test(cText) && /about 7 minutes/.test(cText) && cToastHidden;
console.log('results A/B/D/C:', aOk, bOk, dOk, cOk);

const unexpected = errors.filter((e) => !e.includes('Failed to load resource'));
const pass = !!myLandlet && aOk && bOk && dOk && cOk && unexpected.length === 0;
await finish(browser, {
  pass,
  label: '#3392: an orb pops on contact before the server answers; a 404 plays a reversal with the reason and a 429 brings the orb back with the limit',
  errors,
});
