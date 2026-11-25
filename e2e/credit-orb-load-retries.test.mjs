// #4252: a landlet's credit orbs are fetched when it comes into range. A fetch that fails once used to leave
// the landlet empty until the person walked out of range and back. It is now fetched again after a short wait,
// so the orb appears without moving. The first requests for the landlet's orbs are made to fail here.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox } from './helpers.mjs';

const LABEL = 'Orb Retry Tester';
const LANDLET_ID = `orb-retry-e2e-${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
await seedCreditOrbAsAdmin(LANDLET_ID, { x: 2, y: -1 });

let requests = 0;
let failed = 0;
const FAIL_FIRST = 2; // the page may ask twice on arrival; both asks fail, so nothing else can fill the gap
await page.route('**/api/credit-orbs?landletId=*', (route) => {
  requests += 1;
  if (failed < FAIL_FIRST) { failed += 1; return route.abort('failed'); }
  return route.continue();
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { landlets } = await page.evaluate(async () => (await fetch('/api/landlets?limit=100')).json());
const mine = landlets.find((l) => l.landletId === LANDLET_ID);

const box = await shopStickBox(page);
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [mine.center.x, mine.center.y]);
await page.waitForTimeout(1500);
const afterFailure = await page.evaluate(() => window.__testActiveCreditOrbIds().length);
// (The suite's clock runs ahead of real time, so the wait may already have passed; only the end state is asserted.)
console.log('orbs shortly after the failed fetches:', afterFailure, 'requests so far:', requests);

// Stand still: the next proximity pass after the wait fetches again.
let orbs = 0;
for (let i = 0; i < 40 && orbs === 0; i += 1) {
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__testForceShopProximityCheck());
  orbs = await page.evaluate(() => window.__testActiveCreditOrbIds().length);
}
console.log('orbs after waiting, without moving (should be 1):', orbs, 'requests:', requests);

const pass = failed === FAIL_FIRST && orbs === 1 && requests > FAIL_FIRST;
await finish(browser, { pass, label: 'Credit orbs: a failed fetch is tried again, and the orb appears without moving (#4252)', errors: errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_FAILED')) });
