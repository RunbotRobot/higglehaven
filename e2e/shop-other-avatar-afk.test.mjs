// #4390 (docs/SPEC.md §2): standing still too long shows AFK to the people nearby, not only on your own avatar.
// Two people in one lándlet: A is left idle past the AFK delay, B's scene must carry A's away state;
// an unmoving B stays "present" in A's scene.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'AFK Suite Builder A';
const LABEL_B = 'AFK Suite Builder B';
const LANDLET_ID = 'afk-suite-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
const pageA = sessionA.page;
const pageB = sessionB.page;

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

async function settleInShop(page) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.shop-ready', { timeout: 15000 });
  await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
  await page.evaluate(() => window.__testToggleShopFlight()); // stops the orbit and lands
  await page.waitForTimeout(2500);
}

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;
await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'AFK Suite Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builderA.builderId }),
});
await settleInShop(pageA);
await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;
await fetchJson(pageB, '/api/presence', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 0, y: 0, z: 0, heading: 0, landletId: LANDLET_ID }),
});
await settleInShop(pageB);

const seen = (page, builderId) => page.evaluate((id) => (window.__shopOtherAvatars || []).find((a) => a.builderId === id) ?? null, builderId);
await pageB.waitForFunction((id) => (window.__shopOtherAvatars || []).some((a) => a.builderId === id), builderA.builderId, { timeout: 15000 });
const before = await seen(pageB, builderA.builderId);

// A stands still for longer than the AFK delay; the next report carries it.
await pageA.evaluate(() => window.__testAdvanceShopIdle(100));
let after = null;
for (let i = 0; i < 40 && !after?.afk; i++) {
  await pageB.waitForTimeout(500);
  after = await seen(pageB, builderA.builderId);
}
// B must have reached A's scene before it can be asserted on: on a loaded runner A's poll can lag B's first report.
await pageA.waitForFunction((id) => (window.__shopOtherAvatars || []).some((a) => a.builderId === id), builderB.builderId, { timeout: 30000 });
const bInA = await seen(pageA, builderB.builderId);
console.log('A as B sees it before / after A idles:', before?.afk, after?.afk, '; B as A sees it:', bInA?.afk);

const errors = [...sessionA.errors, ...sessionB.errors];
await sessionB.browser.close();
await finish(sessionA.browser, {
  pass: before?.afk === false && after?.afk === true && bInA?.afk === false && errors.length === 0,
  label: 'Other avatars show a person who has stepped away (#4390)',
  errors,
});
