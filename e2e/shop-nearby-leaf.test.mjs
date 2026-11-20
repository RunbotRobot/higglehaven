// #3824 (part of #3818, #3539): the Nearby leaf, the way to a product for someone with a screen reader on
// a phone (no keyboard, no tapping the world). Seeds a claimed lándlet with two products, opens Shop's own
// menu, taps Nearby, and checks at 390x844: the leaf lists both products by name with a distance, nearest
// first, each row a button of at least 44px; the general menu does not carry Nearby; tapping a row closes
// the leaf and opens that product's card with focus on it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Nearby Leaf Tester';
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
modelForm.append('file', new Blob([await fs.readFile(CRATE_MODEL_PATH)], { type: 'model/gltf-binary' }), 'nearby-leaf-crate.glb');
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
const FOR_SALE_ID = 'nearby-leaf-for-sale';
const SOLD_OUT_ID = 'nearby-leaf-sold-out';
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

const openShopLeaf = async (menu) => {
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded');
  await page.waitForTimeout(300);
  await page.click(`#bud-modes .mode-nav-btn[data-mode="shop"]`);
  await page.waitForTimeout(300);
  await page.click(menu);
  await page.waitForSelector('#bud-leaf-nearby', { timeout: 5000 });
};

// Nearby is under Shop's own petal, not in the general menu.
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded');
await page.waitForTimeout(300);
check(await page.locator('#bud-petal-shop-nearby').count() === 1, 'Shop has a Nearby petal');
check(await page.evaluate(() => document.getElementById('bud-petal-shop-nearby').dataset.budMenu) === 'shop', 'Nearby belongs to Shop\'s menu, not the general one');
await page.click('#account-menu-toggle');
await page.waitForTimeout(300);

await openShopLeaf('#bud-petal-shop-nearby');
const rows = await page.evaluate(() => [...document.querySelectorAll('#bud-leaf-nearby .bud-nearby-row')].map((b) => ({
  name: b.querySelector('.bud-nearby-name').textContent.trim(),
  distance: b.querySelector('.bud-nearby-distance').textContent.trim(),
  height: b.getBoundingClientRect().height,
})));
console.log('rows:', JSON.stringify(rows));
check(rows.length === 2, `the leaf lists both products (got ${rows.length})`);
check(rows.every((r) => r.height >= 44), 'every row is at least 44px tall');
check(rows.every((r) => /^(Here|\d+ m)$/.test(r.distance)), `each row says how far it is (got ${JSON.stringify(rows.map((r) => r.distance))})`);
check(rows.map((r) => r.name).sort().join('|') === 'Card Crate|Card Crate Sold Out', `both products are named (got ${JSON.stringify(rows.map((r) => r.name))})`);
const tree = await page.locator('#bud-leaf-nearby').ariaSnapshot();
check(/button "Card Crate/.test(tree), `a screen reader reaches each product as a button by name (got ${JSON.stringify(tree)})`);

// Tap the second row: the leaf closes and that product's card opens with focus on it.
const pick = rows[rows.length - 1].name;
await page.locator('#bud-leaf-nearby .bud-nearby-row', { hasText: pick }).last().click();
await page.waitForFunction(() => !document.getElementById('product-card').hidden, null, { timeout: 10000 });
await page.waitForTimeout(600);
check(await page.evaluate(() => !document.getElementById('bud-leaf-nearby')), 'tapping a row closes the leaf');
const opened = await page.evaluate(() => document.getElementById('product-card-name').textContent.trim());
check(opened === pick, `the card that opened is the row's product (wanted ${pick}, got ${opened})`);
check(await page.evaluate(() => document.activeElement.id === 'product-card'), 'the card has focus');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

await finish(browser, { pass, label: 'shop-nearby-leaf.test.mjs', errors });
