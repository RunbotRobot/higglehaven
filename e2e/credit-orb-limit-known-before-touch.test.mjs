// #3441: the app knows the orb limit before the touch. After the limit is
// reached, touching an orb leaves it in place (no pop, no toast, no collect
// request) and shows the limit with the time it lifts; and two notices shown
// at once are both readable, neither covering the other.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox, budNoteText, budWordText, readSaying, closeSaying } from './helpers.mjs';

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
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { body: { landlets } } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.landletId === LANDLET_ID);

// Reach the limit: 20 attempts (404s count) against a bogus orb id.
for (let i = 0; i < 20; i += 1) await fetchJson('/api/credit-orbs/not-a-real-orb/collect', { method: 'POST' });
const standing = (await fetchJson('/api/credit-orbs/standing')).body.standing;
console.log('server standing at the limit (remaining should be 0):', JSON.stringify(standing));

// Free the avatar from the spawn orbit, ground it, load the landlet (its orb
// list and the standing arrive with it), then step onto the orb.
const joy = await shopStickBox(page);
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
await page.waitForFunction(() => { const n = document.getElementById('bud-note'); return n && !n.hidden && n.textContent.trim() === 'Orb limit'; }, null, { timeout: 5000 });
await page.waitForTimeout(800);
// #3889: the limit is a word beside the head; its sentence is read in the leaf it opens.
const noticeText = await readSaying(page, 'orb-limit');
const orbStayed = (await page.evaluate(() => window.__testActiveCreditOrbIds())).includes(orbId);
const popEffects = await page.evaluate(() => window.__testActiveCreditOrbPopEffectCount());
const toastVisible = /^\d+ credits?$/.test(await budWordText(page));
console.log('notice:', JSON.stringify(noticeText), '| orb stayed:', orbStayed, '| pop effects:', popEffects, '| toast:', toastVisible, '| collect requests:', collectRequests);
await page.unroute('**/api/credit-orbs/*/collect');

// Reading the sentence is what clears the word: it goes when the leaf is closed, not on a timer.
await closeSaying(page, 'orb-limit');
const wordGoneAfterRead = (await budNoteText(page)) === '';
console.log('closing the leaf after reading clears the word (should be true):', wordGoneAfterRead);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));
const pass = standing.remaining === 0
  && orbStayed && popEffects === 0 && !toastVisible && collectRequests === 0
  && /Try again/.test(noticeText) && !/back where it was/.test(noticeText)
  && wordGoneAfterRead
  && unexpectedErrors.length === 0;
await finish(browser, { pass, label: '#3441: an orb touched at the limit stays put and says why; the word clears once its sentence has been read', errors });
