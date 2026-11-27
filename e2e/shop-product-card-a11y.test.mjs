// #3824 (part of #3818, #3539): the product card for someone who cannot see it or cannot use touch.
// Seeds a claimed landlet with two products (as shop-product-card.test.mjs does), opens the nearest
// card with the N key, and checks at 390x844: the card is a region named by its product and has focus;
// Buy names what it buys and for how much; every control on it can be hit in a 44px square (small
// controls carry an invisible area, so the card looks as it did); Tab reads Buy, More, Close in order;
// More announces whether it is open; no text on the card is under 12px; Escape folds it.
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


// Open a product's card from the keyboard; it takes focus. N opens the nearest to the camera, and which
// of two products 1.6 m apart that is depends on which lándlet this run claimed and where the camera sits
// (#3892), so when the sold-out one comes up first N steps on to the other: the checks below are about the
// for-sale card, and stepping with N is part of what this file is for.
await page.keyboard.press('KeyN');
await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 10000 });
await page.waitForTimeout(1200);
const openName = () => page.evaluate(() => document.getElementById('product-card-name').textContent.trim());
if ((await openName()) !== 'Card Crate') {
  await page.keyboard.press('KeyN');
  await page.waitForFunction(() => document.getElementById('product-card-name').textContent.trim() === 'Card Crate', null, { timeout: 10000 });
  await page.waitForTimeout(1200);
}
check((await openName()) === 'Card Crate', 'N (and N again if the sold-out product came first) opens the for-sale product');

const tree = await page.locator('#product-card').ariaSnapshot();
check(/region "Card Crate"/.test(tree), `the card is a region named by its product (got ${JSON.stringify(tree)})`);
check(/button "Buy Card Crate, \$5\.00"/.test(tree), `Buy names what it buys and for how much (got ${JSON.stringify(tree)})`);
check(/button "More"/.test(tree) && /button "Close"/.test(tree), 'More and Close have names');
check(await page.evaluate(() => document.activeElement.id === 'product-card'), 'the card has focus after N');

// Every control on the card can be hit in a 44px square around its centre (inside the card).
const smallAreas = () => page.evaluate(() => {
  const card = document.getElementById('product-card');
  const box = card.getBoundingClientRect();
  const out = [];
  for (const btn of card.querySelectorAll('button')) {
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(btn).visibility === 'hidden') continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2; // a 44px square, probed 1px inside its edge
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const points = [[-21, -21], [21, -21], [-21, 21], [21, 21]].map(([dx, dy]) => [
      clamp(cx + dx, box.left + 1, box.right - 1), clamp(cy + dy, box.top + 1, box.bottom - 1),
    ]);
    const misses = points.filter(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !(hit === btn || btn.contains(hit));
    });
    // A control whose own box already reaches 44px in a direction is judged on its own box there.
    if (misses.length) out.push(`${btn.id}: ${Math.round(r.width)}x${Math.round(r.height)} misses ${misses.length} of 4 corners (${misses.map(([x, y]) => { const h = document.elementFromPoint(x, y); return `${Math.round(x - r.left)},${Math.round(y - r.top)}->${h && (h.id || h.className || h.tagName)}`; }).join('; ')})`);
  }
  return out;
});
const missed = await smallAreas();
check(missed.length === 0, `every control on the card can be hit in a 44px square (${JSON.stringify(missed)})`);

// Tab reads the card in order: Buy, More, Close.
const order = [];
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Tab');
  order.push(await page.evaluate(() => (document.activeElement.closest('#product-card') ? document.activeElement.id : `OUT:${document.activeElement.id || document.activeElement.tagName}`)));
}
check(JSON.stringify(order) === JSON.stringify(['product-card-buy-btn', 'product-card-more-btn', 'product-card-close-btn']), `Tab reads Buy, More, Close (got ${JSON.stringify(order)})`);

// More says whether it is open, and what it opens is reachable and 44px.
await page.focus('#product-card-more-btn');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
check((await page.getAttribute('#product-card-more-btn', 'aria-expanded')) === 'true', 'More announces that it is open');
const afterMore = await page.locator('#product-card').ariaSnapshot();
check(/button "Return policy"/.test(afterMore), `More opens Return policy as a named button (got ${JSON.stringify(afterMore)})`);
const missedMore = await smallAreas();
check(missedMore.length === 0, `with More open, every control can be hit in a 44px square (${JSON.stringify(missedMore)})`);

// No text under 12px on the card.
const small = await page.evaluate(() => {
  const out = [];
  const walker = document.createTreeWalker(document.getElementById('product-card'), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 12) out.push(`${el.id || el.tagName}:${px}px`);
  }
  return out;
});
check(small.length === 0, `no text on the card is under 12px (${JSON.stringify(small)})`);

// Escape folds the card.
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check(await page.evaluate(() => document.getElementById('product-card').hidden), 'Escape folds the card');
check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'app'), 'Escape leaves keyboard focus on the world, not nowhere (#4594)');

await finish(browser, { pass, label: 'shop-product-card-a11y.test.mjs', errors });
