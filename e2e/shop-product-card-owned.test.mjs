// #3681 (follow-up to #3651, the bud's product card): the card says when the
// shopper already owns a product, and offers no Buy for it. Owned means a digital
// good that stays with its buyer (an avatar or an animation they bought); a plain
// physical product is never called owned. Seeds a claimed landlet with two avatar
// placements and a plain crate, buys one avatar placement (the simulated purchase
// path, admin-only on a seller without Stripe Connect), then, in Shop mode at phone
// width with real taps on the pixels where the products are drawn, checks:
//   - the OTHER avatar placement (same product) says "You already own this." and
//     shows no Buy petal;
//   - the plain crate still offers Buy and is not called owned;
//   - the owned lists are read once, not on every tap.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Owned Card Tester';
const VIEWPORT = { width: 390, height: 844 };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: VIEWPORT });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const modelForm = new FormData();
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'product-card-crate.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) throw new Error(`model upload failed (${modelUploadRes.status})`);
const sessionCookie = (await page.context().cookies()).find((c) => c.name === 'hh_session');
async function createTemplate(fields) {
  const res = await fetch(`${BASE_URL}/api/catalog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie ? `hh_session=${sessionCookie.value}` : '' },
    body: JSON.stringify({
      category: 'placeholder', color: '#8899aa',
      dimensions: { width: 1.2, depth: 1.2, height: 1.2 },
      sellerId: sellerMeBody.seller.sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes,
      ...fields,
    }),
  });
  const body = await res.json();
  if (res.status !== 200 && res.status !== 201) throw new Error(`catalog template create failed (${res.status}): ${JSON.stringify(body)}`);
  return body.template.templateId;
}
// An avatar is a digital good that stays with its buyer; a plain crate is not.
const avatarTemplate = await createTemplate({ name: 'Owned Avatar', category: 'avatar', priceCents: 500 });
const plainTemplate = await createTemplate({ name: 'Plain Crate', priceCents: 500 });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

// Two avatar placements (one gets bought) and a plain crate beside them.
const BOUGHT_ID = 'owned-card-bought';
const OWNED_ID = 'owned-card-avatar';
const PLAIN_ID = 'owned-card-plain';
const batch = (await pageFetchJson('/api/instances/batch', json({
  instances: [
    { instanceId: BOUGHT_ID, landletId: landlet.landletId, templateId: avatarTemplate, x: -1.6, y: 0 },
    { instanceId: OWNED_ID, landletId: landlet.landletId, templateId: avatarTemplate, x: 0, y: 0 },
    { instanceId: PLAIN_ID, landletId: landlet.landletId, templateId: plainTemplate, x: 1.6, y: 0 },
  ],
}))).status;
console.log('seeded three placements:', batch);

// The simulated purchase path is admin-only on a seller without Stripe Connect:
// grant it to this same account (same as e2e/avatar-equip-refreshes-animations-list.test.mjs).
await grantAdmin(emailForLabel(LABEL));
const bought = await pageFetchJson(`/api/instances/${BOUGHT_ID}/purchase`, { method: 'POST' });
console.log('bought one avatar placement (should be 201):', bought.status);

// The page's catalog was fetched before these products existed.
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 }); // #3669: the fly button is gone
await page.waitForTimeout(1000);

// A fresh Shop-mode spawn keeps overwriting the avatar's position until real
// navigation input first arrives; the same release gesture other Shop e2es use.
// #3669: the on-screen stick is gone; a short key press is the same first navigation input.
await page.keyboard.down('KeyD');
await page.waitForTimeout(150);
await page.keyboard.up('KeyD');
await page.waitForTimeout(100);

// E2E_SHOT_DIR=<dir> saves a screenshot at each stage (for a PR description).
const shot = async (name) => {
  if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOT_DIR, `product-card-${name}.png`) });
};

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const cx = landlet.center.x;
const cy = landlet.center.y;
const moveTo = ([x, y]) => page.evaluate(([px, py]) => {
  window.__testTeleportShopAvatar(px, py, 0);
  window.__testForceShopProximityCheck();
}, [x, y]);
const screenPoint = (id) => page.evaluate((instanceId) => window.__testShopScreenPointOfInstance(instanceId), id);
const cardRect = () => page.evaluate(() => {
  const el = document.getElementById('product-card');
  if (!el || el.hidden) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, side: el.dataset.side, edge: el.dataset.edge, state: el.dataset.state };
});
const cardOpen = async () => (await cardRect()) !== null;
const inside = (rect, p) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;

// Stand where the camera looks at the products, so real taps can reach them.
await moveTo([cx, cy]);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() >= 2, null, { timeout: 30000 });
await page.waitForTimeout(800);
const view = await page.evaluate(() => window.__testShopCameraView());
const heading = Math.hypot(view.dx, view.dy) || 1;
let ownedPoint = null;
let plainPoint = null;
for (const back of [2.5, 3.5, 1.5, 4.5, 0.5]) {
  await moveTo([cx - (view.dx / heading) * back, cy - (view.dy / heading) * back]);
  await page.waitForTimeout(800);
  ownedPoint = await screenPoint(OWNED_ID);
  plainPoint = await screenPoint(PLAIN_ID);
  const centred = (p) => p && p.inFront && Math.abs(p.ndcX) < 0.93 && Math.abs(p.ndcY) < 0.8;
  if (centred(ownedPoint) && centred(plainPoint)) break;
  ownedPoint = null;
}
check(ownedPoint !== null, 'both products can be put on screen');
if (!ownedPoint) await finish(browser, { pass: false, label: '#3681: owned product card (could not frame the products)', errors });

const cardState = () => page.evaluate(() => ({
  hidden: document.getElementById('product-card').hidden,
  name: document.getElementById('product-card-name').textContent.trim(),
  state: document.getElementById('product-card-state').textContent.trim(),
  buyShown: document.getElementById('product-card-buy-btn').classList.contains('visible'),
}));

// The owned lists are read once per page; count how often they are asked for.
let ownedListRequests = 0;
page.on('request', (req) => {
  if (/\/api\/builders\/me\/(avatars|animations)(\?|$)/.test(req.url()) && req.method() === 'GET') ownedListRequests += 1;
});

// A real tap on the avatar placement that was NOT bought: the product is owned all the same.
await page.mouse.click(ownedPoint.x, ownedPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 5000 });
await page.waitForFunction(() => document.getElementById('product-card-state').textContent.includes('already own'), null, { timeout: 8000 }).catch(() => {});
const owned = await cardState();
console.log('owned avatar card:', JSON.stringify(owned));
check(owned.name === 'Owned Avatar', 'the card names the avatar');
check(owned.state === 'You already own this.', `the card says the shopper already owns it (${owned.state})`);
check(!owned.buyShown, 'an owned avatar offers no Buy petal');

// Close, then tap the plain crate: it is not a digital good, so Buy is still offered.
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('product-card').hidden, null, { timeout: 5000 });
await page.mouse.click(plainPoint.x, plainPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden && document.getElementById('product-card-name').textContent.trim() === 'Plain Crate', null, { timeout: 5000 });
await page.waitForTimeout(1500);
const plain = await cardState();
console.log('plain crate card:', JSON.stringify(plain));
check(plain.state !== 'You already own this.', 'a product that is not a digital good is never called owned');
check(plain.buyShown, 'a plain product the shopper does not own still offers Buy');

// Back to the avatar: still owned, and no further request for the owned lists.
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('product-card').hidden, null, { timeout: 5000 });
await page.mouse.click(ownedPoint.x, ownedPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden && document.getElementById('product-card-name').textContent.trim() === 'Owned Avatar', null, { timeout: 5000 });
await page.waitForTimeout(500);
const again = await cardState();
check(again.state === 'You already own this.' && !again.buyShown, 'tapping the avatar again says the same');
console.log('requests for the owned lists across all three taps (one read of each list, no more):', ownedListRequests);
check(ownedListRequests <= 2, `the owned lists are not asked for on every tap (${ownedListRequests} requests)`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3681: a product card says when the shopper already owns the digital good, and offers Buy for anything else', errors });
