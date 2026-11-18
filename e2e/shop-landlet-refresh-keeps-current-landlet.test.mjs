// #3647: a record refresh must never leave the shopper standing on no lándlet.
//
// enterShopMode re-syncs every landlet's record every 20 s. When the shopper's
// own landlet is among those updated, the refresh used to reset
// shopCurrentLandletEntry to null and leave it null until the next proximity
// tick a few frames later. A presence report landing in that gap put the
// shopper's own row on no lándlet (so their own "who is nearby" GET answered
// nobody, and they vanished for everyone else), and a poll landing in it
// despawned every other avatar. That was the flake in
// shop-presence-background-tab-despawn.test.mjs ("B sees A before
// backgrounding: undefined"): a real product bug, once every 20 s.
//
// The check is deterministic: after the refresh's promise resolves, the next
// thing to run is the code awaiting it, before any frame or timer, so reading
// the current lándlet there reads exactly what a report or poll in that gap
// would have read.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Landlet Refresh Suite Builder';
const LANDLET_ID = 'landlet-refresh-keeps-current-landlet';

const session = await launchPage({ promptAnswer: LABEL });
const { page } = session;

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const builder = (await fetchJson('/api/builders/me')).body.builder;
const created = await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Landlet Refresh Suite Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builder.builderId,
  }),
});
console.log('landlet created (status should be 201):', created.status);

// Same land-on-the-landlet sequence as e2e/shop-presence-background-tab-despawn.test.mjs.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(2500);

const standingOn = async () => page.evaluate(() => window.__testShopCurrentLandletId());
const deadline = Date.now() + 20000;
let before = await standingOn();
while (before !== LANDLET_ID && Date.now() < deadline) {
  await page.waitForTimeout(250);
  before = await standingOn();
}
console.log('standing on the test landlet before any refresh (should be true):', before === LANDLET_ID);

// Three refreshes in a row, each read the moment its promise resolves.
const rightAfterRefresh = await page.evaluate(async () => {
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await window.__testForceShopLandletRecordRefresh();
    seen.push(window.__testShopCurrentLandletId());
  }
  return seen;
});
console.log('lándlet read right after each refresh (should all be the test landlet):', rightAfterRefresh);

const pass = created.status === 201
  && before === LANDLET_ID
  && rightAfterRefresh.length === 3
  && rightAfterRefresh.every((id) => id === LANDLET_ID)
  && session.errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#3647: a landlet record refresh never leaves the shopper standing on no lándlet, even for the instant before the next proximity tick',
  errors: session.errors,
});
