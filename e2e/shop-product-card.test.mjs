// #3651 (leaf 3/9 of #3648, the bud): tapping a product makes its card bloom
// beside it. Seeds a claimed landlet with two products standing close together
// (one for sale, one out of stock) and checks, in Shop mode at phone width, with
// real taps on the pixels where the products are drawn:
//   - the card opens, arriving through fog (it blooms, then rests);
//   - it shows the name and price, and the yellow Buy petal for a product that is
//     for sale and within reach;
//   - it sits BESIDE the product, never over it, stays on screen, and follows the
//     product when the view moves;
//   - its text can be selected;
//   - "More" opens Rate this Product and Return Policy, and Return Policy opens
//     and closes without folding the card;
//   - Buy asks for confirmation naming the price; cancelling starts no checkout
//     and leaves the card open (the real checkout itself is covered by
//     purchase-checkout-real-stripe.test.mjs, which runs with Stripe keys);
//   - tapping the neighbouring product moves the card to it, and an out-of-stock
//     product says so and shows no Buy petal;
//   - Escape and tapping the world fold the card away, and the old product-preview
//     modal is gone.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Product Card Tester';
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
const forSaleTemplate = await createTemplate({ name: 'Card Crate', priceCents: 500 });
const soldOutTemplate = await createTemplate({ name: 'Card Crate Sold Out', priceCents: 700, stockQuantity: 0 });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

// Two products 1.6 m apart: close together on purpose.
const FOR_SALE_ID = 'product-card-for-sale';
const SOLD_OUT_ID = 'product-card-sold-out';
const batch = (await pageFetchJson('/api/instances/batch', json({
  instances: [
    { instanceId: FOR_SALE_ID, landletId: landlet.landletId, templateId: forSaleTemplate, x: 0, y: 0 },
    { instanceId: SOLD_OUT_ID, landletId: landlet.landletId, templateId: soldOutTemplate, x: 1.6, y: 0 },
  ],
}))).status;
console.log('seeded two products:', batch);

// The page's catalog was fetched before these products existed.
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForTimeout(1000);

// A fresh Shop-mode spawn keeps overwriting the avatar's position until real
// navigation input first arrives; the same release gesture other Shop e2es use.
const joystickBox = await shopStickBox(page);
const joystickX = joystickBox.x + joystickBox.width / 2;
const joystickY = joystickBox.y + joystickBox.height / 2;
await page.mouse.move(joystickX, joystickY);
await page.mouse.down();
await page.mouse.move(joystickX + 25, joystickY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
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

// Stand where the camera looks at both products, so real taps can reach them.
await moveTo([cx, cy]);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() >= 2, null, { timeout: 30000 });
await page.waitForTimeout(800);
const view = await page.evaluate(() => window.__testShopCameraView());
const heading = Math.hypot(view.dx, view.dy) || 1;
let aPoint = null;
let bPoint = null;
for (const back of [2.5, 3.5, 1.5, 4.5, 0.5]) {
  await moveTo([cx - (view.dx / heading) * back, cy - (view.dy / heading) * back]);
  await page.waitForTimeout(800);
  aPoint = await screenPoint(FOR_SALE_ID);
  bPoint = await screenPoint(SOLD_OUT_ID);
  // Both fully on screen. The camera looks steeply down, so two products 1.6 m apart are far
  // apart on a phone: the neighbour sits near the right edge, which is a case worth having.
  const centred = (p) => p && p.inFront && Math.abs(p.ndcX) < 0.93 && Math.abs(p.ndcY) < 0.8;
  console.log(`framing back=${back}: A ${JSON.stringify(aPoint)} B ${JSON.stringify(bPoint)} view ${JSON.stringify(view)}`);
  if (centred(aPoint) && centred(bPoint)) break;
  aPoint = null;
}
check(aPoint !== null, 'both products can be put on screen');
if (!aPoint) await finish(browser, { pass: false, label: '#3651: product card (could not frame the products)', errors });

// The old product preview modal is gone.
check(await page.locator('#shop-product-preview-modal').count() === 0, 'the old product preview modal is not in the page');
check(!(await cardOpen()), 'no card is open before a tap');

// A real tap on the for-sale product.
await page.mouse.click(aPoint.x, aPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 5000 });
const justOpened = await cardRect();
check(justOpened.state === 'blooming' || justOpened.state === 'open', `the card arrives through its bloom (state ${justOpened.state})`);
await page.waitForFunction(() => document.getElementById('product-card').dataset.state === 'open', null, { timeout: 4000 });
check((await page.textContent('#product-card-name')).trim() === 'Card Crate', 'the card names the product');
check((await page.textContent('#product-card-price')).trim() === '$5.00', 'the card shows the price');
// #3680: the card names the seller (their storefront name), filled in when the lookup answers.
await page.waitForFunction(() => document.getElementById('product-card-seller').textContent.trim() !== '', null, { timeout: 8000 }).catch(() => {});
check((await page.textContent('#product-card-seller')).trim() === `Sold by ${sellerMeBody.seller.label}`, 'the card names the seller');
try {
  await page.waitForSelector('#product-card-buy-btn.visible', { timeout: 8000 });
} catch (err) {
  console.log('Buy never showed; last hint debug:', JSON.stringify(await page.evaluate(() => window.__lastShopBuyHintDebug)));
  check(false, 'a product for sale, within reach, offers the yellow Buy petal');
}
check(await page.locator('#product-card-state').innerText() === '', 'a product for sale that can be bought says nothing is wrong');
const buyColor = await page.evaluate(() => getComputedStyle(document.getElementById('product-card-buy-btn')).backgroundColor);
console.log('Buy petal colour:', buyColor);
check(buyColor === 'rgb(246, 214, 92)', `the Buy petal is the brand yellow (${buyColor})`);

// Beside the product, never over it; on screen; pointing at it.
const rect1 = await cardRect();
const anchor1 = await page.evaluate(() => window.__testProductCardAnchor());
console.log('card:', JSON.stringify(rect1), 'anchor:', JSON.stringify(anchor1), 'product point:', JSON.stringify(aPoint));
await shot('middle-of-screen');
console.log(`card covers ${(100 * (rect1.width * rect1.height) / (VIEWPORT.width * VIEWPORT.height)).toFixed(1)}% of the 390x844 screen`);
check(!inside(rect1, aPoint), 'the card does not cover the product it describes');
check(rect1.left >= 0 && rect1.top >= 0 && rect1.right <= VIEWPORT.width && rect1.bottom <= VIEWPORT.height, 'the card is fully on screen');
check(rect1.edge === 'false', 'a product in the middle of the screen gets a card with a pointer to it');
check(Math.abs(anchor1.x - aPoint.x) < 4 && Math.abs(anchor1.y - aPoint.y) < 4, 'the card is anchored to where the product is drawn');
// Text is selectable, and nothing over the text blocks pointer events.
const selectable = await page.evaluate(() => {
  const card = document.getElementById('product-card');
  const name = document.getElementById('product-card-name');
  return {
    cardSelect: getComputedStyle(card).userSelect, nameSelect: getComputedStyle(name).userSelect, namePointer: getComputedStyle(name).pointerEvents,
  };
});
check(selectable.cardSelect === 'text' && selectable.nameSelect === 'text' && selectable.namePointer !== 'none', `the card's text can be selected (${JSON.stringify(selectable)})`);

// The card follows the product when the view moves. It is per-frame work, so the
// longest frame while it follows is measured ("Moving, looking and drawing never
// wait on loading": the same ceiling the other Shop e2es use).
const before = await cardRect();
await page.evaluate(() => window.__frameMonitor.reset());
await moveTo([cx - (view.dx / heading) * 3.6 + (-view.dy / heading) * 0.9, cy - (view.dy / heading) * 3.6 + (view.dx / heading) * 0.9]);
await page.waitForTimeout(600);
const aMoved = await screenPoint(FOR_SALE_ID);
const after = await cardRect();
console.log('after the view moved: product', JSON.stringify(aMoved), 'card', JSON.stringify(after));
check(after !== null, 'the card is still open after the view moved a little');
if (after && aMoved) {
  check(Math.abs(after.left - before.left) > 1 || Math.abs(after.top - before.top) > 1, 'the card moved with the product');
  check(!inside(after, aMoved), 'it still does not cover the product');
  const anchor2 = await page.evaluate(() => window.__testProductCardAnchor());
  check(Math.abs(anchor2.x - aMoved.x) < 4 && Math.abs(anchor2.y - aMoved.y) < 4, 'and it is still anchored to the product');
}
const followFrame = await page.evaluate(() => ({ longestGapMs: window.__frameMonitor.longestFrameGapMs() }));
console.log(`longest frame gap while the card followed the product: ${Math.round(followFrame.longestGapMs)} ms`);
check(followFrame.longestGapMs < Number(process.env.E2E_MAX_FRAME_GAP_MS || 250), `the card following the product never holds a frame back (longest gap ${Math.round(followFrame.longestGapMs)} ms)`);
// Back to a framing where both are tappable.
await moveTo([cx - (view.dx / heading) * 2.5, cy - (view.dy / heading) * 2.5]);
await page.waitForTimeout(800);

// More: Rate this Product and Return Policy open from the card.
check(!(await page.locator('#product-card-review-btn').isVisible()), 'Rate this Product is tucked away until More is opened');
await page.click('#product-card-more-btn');
check(await page.locator('#product-card-review-btn').isVisible(), 'More opens Rate this Product');
check(await page.locator('#product-card-return-policy-btn').isVisible(), 'More opens Return Policy');
await page.click('#product-card-return-policy-btn');
await page.waitForSelector('#refund-policy-modal.visible', { timeout: 5000 });
await page.click('#refund-policy-close-btn');
await page.waitForFunction(() => !document.getElementById('refund-policy-modal').classList.contains('visible'), null, { timeout: 5000 });
check(await cardOpen(), 'closing the Return Policy leaves the card open');

// Buy asks first, naming the price; cancelling starts no checkout.
await page.click('#product-card-buy-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
check(/\$5\.00/.test(await page.textContent('#confirm-modal-message')), 'Buy asks for confirmation, naming the price');
await page.click('#confirm-modal-cancel-btn');
await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
check((await page.locator('#checkout-modal.visible').count()) === 0, 'cancelling the confirmation starts no checkout');
check(await cardOpen(), 'cancelling the confirmation leaves the card open');

// Escape folds the card (and the tapped product's highlight goes with it).
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(!(await cardOpen()), 'Escape folds the card away');
check(await page.evaluate(() => window.__testShopTappedInstanceId()) === null, 'the tapped product is forgotten too');

// Two products close together: tapping the neighbour moves the card to it.
bPoint = await screenPoint(SOLD_OUT_ID);
aPoint = await screenPoint(FOR_SALE_ID);
await page.mouse.click(bPoint.x, bPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 5000 });
check((await page.textContent('#product-card-name')).trim() === 'Card Crate Sold Out', 'tapping the neighbouring product opens its own card');
await page.waitForFunction(() => document.getElementById('product-card-state').textContent.trim() !== '', null, { timeout: 5000 });
check(/out of stock/i.test(await page.textContent('#product-card-state')), 'an out-of-stock product says so in plain words');
check(!(await page.locator('#product-card-buy-btn').isVisible()), 'and shows no Buy petal');
const rectB = await cardRect();
await shot('neighbour-near-the-edge');
check(!inside(rectB, bPoint), 'the neighbour\'s card does not cover its product either');
check(rectB.left >= 0 && rectB.right <= VIEWPORT.width && rectB.top >= 0 && rectB.bottom <= VIEWPORT.height, 'the neighbour\'s card is on screen');

// A product far away and tiny: the card keeps its size and a readable gap, and stays
// on screen. (The tap itself needs a pixel to aim at, so the card is opened the way
// the other e2e files open one, by instance id.)
await page.keyboard.press('Escape');
await moveTo([cx - (view.dx / heading) * 38, cy - (view.dy / heading) * 38]);
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() >= 2, null, { timeout: 30000 });
await page.waitForTimeout(800);
const farPoint = await screenPoint(FOR_SALE_ID);
console.log('far product point:', JSON.stringify(farPoint));
if (farPoint && farPoint.inFront) {
  await page.evaluate((id) => window.__testTapShopProductByInstanceId(id), FOR_SALE_ID);
  await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 5000 });
  await page.waitForTimeout(700);
  const farRect = await cardRect();
  const farAnchor = await page.evaluate(() => window.__testProductCardAnchor());
  console.log('far card:', JSON.stringify(farRect), 'anchor:', JSON.stringify(farAnchor));
  await shot('far-away-tiny');
  check(farRect.width === rect1.width, 'the card is the same size for a far product as for a near one');
  check(farRect.left >= 0 && farRect.right <= VIEWPORT.width && farRect.top >= 0 && farRect.bottom <= VIEWPORT.height, 'the far product\'s card is on screen');
  check(!inside(farRect, farPoint), 'and does not cover the tiny product');
  check(farAnchor.radius >= 10, `the tiny product still gets a readable gap (radius ${farAnchor.radius.toFixed(1)} px)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
} else {
  check(false, 'the product is still drawn when 38 m away');
}
await moveTo([cx - (view.dx / heading) * 2.5, cy - (view.dy / heading) * 2.5]);
await page.waitForTimeout(800);
aPoint = await screenPoint(FOR_SALE_ID);
bPoint = await screenPoint(SOLD_OUT_ID);

// Tapping the world (nowhere near a product) folds the card.
await page.mouse.click(bPoint.x, bPoint.y);
await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 5000 });
const candidates = [[VIEWPORT.width * 0.88, VIEWPORT.height * 0.22], [VIEWPORT.width * 0.12, VIEWPORT.height * 0.22], [VIEWPORT.width * 0.5, VIEWPORT.height * 0.1]];
let emptyPoint = null;
for (const [x, y] of candidates) {
  const rect = await cardRect();
  const nearProduct = [aPoint, bPoint].some((p) => p && Math.hypot(p.x - x, p.y - y) < 120);
  if (!nearProduct && !(rect && inside(rect, { x, y }))) { emptyPoint = { x, y }; break; }
}
check(emptyPoint !== null, 'there is an empty patch of world to tap');
if (emptyPoint) {
  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  await page.waitForTimeout(400);
  check(!(await cardOpen()), 'tapping the world folds the card away');
}

await finish(browser, { pass: pass && errors.length === 0, label: '#3651: a tapped product\'s card blooms beside it, follows it, offers Buy only when it can, and folds away', errors });
