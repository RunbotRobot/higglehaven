// #4612 (Basket 2/7, part of #4604): a shopper gathers things in a basket. Seeds a claimed lándlet with a plain
// crate and an avatar, then, in Shop mode at phone width with real taps on the products:
//   - the crate's card offers "Add to basket" and tapping it says so in the card's own line;
//   - the avatar's card offers Buy but no "Add to basket" (it stays with its buyer);
//   - the Basket leaf of the Shop stem lists the crate under its seller, "+" and "−" change the quantity, and
//     Remove empties it to the one sentence an empty basket shows.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Basket Tester';
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
const avatarTemplate = await createTemplate({ name: 'Basket Avatar', category: 'avatar', priceCents: 500 });
const plainTemplate = await createTemplate({ name: 'Basket Crate', priceCents: 500 });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

// Two products side by side: a plain crate and an avatar.
const PLAIN_ID = 'basket-card-plain';
const AVATAR_ID = 'basket-card-avatar';
const batch = (await pageFetchJson('/api/instances/batch', json({
  instances: [
    { instanceId: PLAIN_ID, landletId: landlet.landletId, templateId: plainTemplate, x: -1.6, y: 0 },
    { instanceId: AVATAR_ID, landletId: landlet.landletId, templateId: avatarTemplate, x: 1.6, y: 0 },
  ],
}))).status;
console.log('seeded two placements:', batch);

await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForTimeout(1000);
await page.keyboard.down('KeyD');
await page.waitForTimeout(150);
await page.keyboard.up('KeyD');
await page.waitForTimeout(100);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const cx = landlet.center.x;
const cy = landlet.center.y;
const moveTo = ([x, y]) => page.evaluate(([px, py]) => {
  window.__testTeleportShopAvatar(px, py, 0);
  window.__testForceShopProximityCheck();
}, [x, y]);
const screenPoint = (id) => page.evaluate((instanceId) => window.__testShopScreenPointOfInstance(instanceId), id);

await moveTo([cx, cy]);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() >= 2, null, { timeout: 30000 });
await page.waitForTimeout(800);
const view = await page.evaluate(() => window.__testShopCameraView());
const heading = Math.hypot(view.dx, view.dy) || 1;
let plainPoint = null;
let avatarPoint = null;
for (const back of [2.5, 3.5, 1.5, 4.5, 0.5]) {
  await moveTo([cx - (view.dx / heading) * back, cy - (view.dy / heading) * back]);
  await page.waitForTimeout(800);
  plainPoint = await screenPoint(PLAIN_ID);
  avatarPoint = await screenPoint(AVATAR_ID);
  const centred = (p) => p && p.inFront && Math.abs(p.ndcX) < 0.93 && Math.abs(p.ndcY) < 0.8;
  if (centred(plainPoint) && centred(avatarPoint)) break;
  plainPoint = null;
}
check(plainPoint !== null, 'both products can be put on screen');
if (!plainPoint) await finish(browser, { pass: false, label: '#4612: basket (could not frame the products)', errors });

const card = () => page.evaluate(() => ({
  name: document.getElementById('product-card-name').textContent.trim(),
  state: document.getElementById('product-card-state').textContent.trim(),
  buyShown: document.getElementById('product-card-buy-btn').classList.contains('visible'),
  basketShown: document.getElementById('product-card-basket-btn').classList.contains('visible'),
}));
const openCardOf = async (point, name) => {
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((n) => !document.getElementById('product-card').hidden && document.getElementById('product-card-name').textContent.trim() === n, name, { timeout: 5000 });
  await page.waitForTimeout(1500);
};

// The avatar offers Buy but not a basket.
await openCardOf(avatarPoint, 'Basket Avatar');
const avatarCard = await card();
console.log('avatar card:', JSON.stringify(avatarCard));
check(avatarCard.buyShown, 'the avatar still offers Buy');
check(!avatarCard.basketShown, 'an avatar offers no Add to basket');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('product-card').hidden, null, { timeout: 5000 });

// The crate offers it, and adding says so in the card.
await openCardOf(plainPoint, 'Basket Crate');
const crateCard = await card();
check(crateCard.basketShown, 'the crate offers Add to basket');
await page.click('#product-card-basket-btn');
await page.waitForFunction(() => document.getElementById('product-card-state').textContent.includes('Added to your basket'), null, { timeout: 8000 });
console.log('after adding:', JSON.stringify(await card()));
await page.click('#product-card-basket-btn');
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('product-card').hidden, null, { timeout: 5000 });

// The Basket leaf: open it from the Shop stem.
await page.click('#account-menu-toggle');
await page.waitForSelector('#bud-petal-shop-basket', { timeout: 8000 });
await page.click('#bud-petal-shop-basket');
await page.waitForSelector('#bud-leaf-basket .basket-row', { timeout: 8000 });
const leaf = () => page.evaluate(() => ({
  sellers: [...document.querySelectorAll('#bud-leaf-basket .basket-seller')].map((e) => e.textContent.trim()),
  names: [...document.querySelectorAll('#bud-leaf-basket .basket-row .my-purchase-name')].map((e) => e.textContent.trim()),
  quantity: document.querySelector('#bud-leaf-basket .basket-quantity')?.textContent.trim() ?? null,
  text: document.querySelector('#bud-leaf-basket .bud-leaf-body')?.textContent.trim() ?? '',
}));
const first = await leaf();
console.log('basket leaf:', JSON.stringify(first));
check(first.names.length === 1 && first.names[0] === 'Basket Crate', 'the basket lists the crate once');
check(first.quantity === '2', `two taps of Add to basket make quantity 2 (${first.quantity})`);
check(first.sellers.length === 1 && first.sellers[0].length > 0, 'the line sits under its seller');

// #4666: the leaf also asks for the server's quote. A tester with a verified session sees each line's price and a
// total; one without sees the route's own sentence above the same lines (never a silent blank).
const quoted = await page.evaluate(() => ({
  prices: document.querySelectorAll('#bud-leaf-basket .basket-line-price').length,
  total: document.querySelector('#bud-leaf-basket .basket-total')?.textContent.trim() ?? null,
  refusal: document.querySelector('#bud-leaf-basket .orders-note.error')?.textContent.trim() ?? null,
}));
console.log('quote in leaf:', JSON.stringify(quoted));
check((quoted.prices === 1 && quoted.total !== null) || (quoted.refusal && quoted.refusal.length > 0), 'the leaf shows the quote, or says why it has none');

await page.click('#bud-leaf-basket button[aria-label^="One fewer"]');
await page.waitForFunction(() => document.querySelector('#bud-leaf-basket .basket-quantity')?.textContent.trim() === '1', null, { timeout: 8000 });
await page.click('#bud-leaf-basket button[aria-label^="One more"]');
await page.waitForFunction(() => document.querySelector('#bud-leaf-basket .basket-quantity')?.textContent.trim() === '2', null, { timeout: 8000 });
check(await page.isDisabled('#bud-leaf-basket button[aria-label^="One fewer"]') === false, 'the minus is usable at two');

await page.click('#bud-leaf-basket button[aria-label^="Remove"]');
await page.waitForFunction(() => document.querySelector('#bud-leaf-basket .empty-state'), null, { timeout: 8000 });
const emptied = await leaf();
check(emptied.text.startsWith('Your basket is empty.'), `an empty basket says so (${emptied.text})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#4612: add to basket from a card, read and change it in the Basket leaf, and an avatar offers no basket', errors });
