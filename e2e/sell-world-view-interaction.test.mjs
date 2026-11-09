// #3296 (leaf 5/6 of #3291, part of #3253): the old fixed camera made these
// trivial; with Shop's movement mounted in Sell (#3295) they need to keep
// working. Tapping a product from the follow camera still opens Manage (and the
// movement HUD goes quiet under the modal whichever way it was opened), a key
// held while the modal opens leaves nothing stuck, Next/Prev put the avatar back
// at the start of the new page, and the pager never sits under the HUD.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const BENCH_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'bench.glb');
const TABLE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'table.glb');

const LABEL = 'Sell World View Interaction Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

// One real product through the upload flow ...
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'Interaction Crate');
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);

// ... and two heavy-declared fillers straight through the API (same approach as
// sell-mode-showcase) so the showcase has at least two pages. Reloading the app
// afterwards (below) makes the client learn about them.
async function uploadModel(localPath) {
  const bytes = await fs.readFile(localPath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'model/gltf-binary' }), path.basename(localPath));
  const response = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: form });
  const body = await response.json();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`uploadModel failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}
const cookies = await page.context().cookies();
const sessionCookie = cookies.find((c) => c.name === 'hh_session');
const cookieHeader = sessionCookie ? `hh_session=${sessionCookie.value}` : '';
const { templates: ownTemplates } = await page.evaluate(async () => (await fetch('/api/catalog?limit=100')).json());
const sellerId = ownTemplates.find((t) => t.name === 'Interaction Crate')?.sellerId;
async function seedHeavyTemplate(name, modelUrl) {
  const response = await fetch(`${BASE_URL}/api/catalog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      name, category: 'placeholder', color: '#887755',
      dimensions: { width: 1, depth: 1, height: 1 },
      sellerId, modelUrl, modelSizeBytes: 7 * 1024 * 1024, priceCents: 500,
    }),
  });
  const body = await response.json();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`seedHeavyTemplate(${name}) failed (${response.status}): ${JSON.stringify(body)}`);
  }
}
const [benchUpload, tableUpload] = await Promise.all([uploadModel(BENCH_MODEL_PATH), uploadModel(TABLE_MODEL_PATH)]);
await seedHeavyTemplate('Interaction Filler A', benchUpload.modelUrl);
await seedHeavyTemplate('Interaction Filler B', tableUpload.modelUrl);

// (A mode-nav round trip rather than page.reload(): a plain reload does not stay in
// Sell, the nav buttons set the start mode for the next load.)
if (await page.locator('#seller-modal.visible').isVisible()) {
  await page.click('#seller-close-btn');
  await page.waitForTimeout(300);
}
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForFunction(() => window.__sellWorldViewActive?.() === true, null, { timeout: 30000 });
await page.click('#seller-close-btn');
await page.waitForTimeout(800);

const pageLabel = await page.textContent('#seller-showcase-page-label');
const multiPage = /Page 1 of [2-9]/.test(pageLabel || '');
console.log('showcase has at least two pages (should be true):', multiPage, pageLabel);

const hudSelectors = ['#shop-move-joystick', '#shop-look-joystick', '#shop-fly-btn'];
const overlaps = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
async function pagerClearOfHud(label) {
  const pager = await page.locator('#seller-showcase-pager').boundingBox();
  const manage = await page.locator('#seller-showcase-manage-btn').boundingBox();
  const hud = await Promise.all(hudSelectors.map((s) => page.locator(s).boundingBox()));
  const hits = [...hud.map((box, i) => overlaps(pager, box) && hudSelectors[i]), overlaps(manage, pager) && 'manage-btn'];
  const hudHits = hits.filter(Boolean).concat(hud.map((box, i) => overlaps(manage, box) && `manage-vs-${hudSelectors[i]}`).filter(Boolean));
  console.log(`${label}: pager/Products button overlapping the HUD or each other (should be none):`, hudHits);
  return hudHits.length === 0;
}
const clearAtStart = await pagerClearOfHud('at start');

// 1) Walk off the start spot, then tap a product from the follow camera: Manage
// opens for it, and the movement HUD goes quiet under the modal even though the
// tap path opens the modal without going through openSellerModal.
await page.keyboard.down('KeyD');
await page.waitForTimeout(500);
await page.keyboard.up('KeyD');
let tapped = false;
scan: for (const fy of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]) {
  for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
    await page.mouse.click(420 * fx, 860 * fy);
    await page.waitForTimeout(250);
    if (await page.locator('#seller-modal.visible').isVisible()) { tapped = true; break scan; }
  }
}
console.log('tapping a product after walking opened Manage (should be true):', tapped);
const rowExpanded = (await page.locator('.seller-row.expanded').count()) >= 1;
console.log('the tapped product row is expanded (should be true):', rowExpanded);
await page.waitForTimeout(200);
const hudUnderTapModal = await Promise.all(hudSelectors.map((s) => page.locator(s).isVisible()));
console.log('movement HUD hidden under the modal opened by a tap (should be all false):', hudUnderTapModal);
await page.click('#seller-close-btn');
await page.waitForTimeout(500);

// 2) A key held while the modal opens leaves nothing stuck: hold W, open the
// modal with a mouse click, keep holding, and the avatar stays put; after
// releasing and closing, it still does not drift.
const posBeforeHold = await page.evaluate(() => window.__testShopAvatarPosition());
await page.keyboard.down('KeyA');
await page.waitForTimeout(200);
await page.click('#seller-showcase-manage-btn');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
const posModalOpen = await page.evaluate(() => window.__testShopAvatarPosition());
await page.waitForTimeout(700);
const posModalStillHeld = await page.evaluate(() => window.__testShopAvatarPosition());
await page.keyboard.up('KeyA');
const movedWhileHeld = Math.hypot(posModalStillHeld.x - posModalOpen.x, posModalStillHeld.y - posModalOpen.y) > 0.01;
console.log('avatar moved while a key was held under the open modal (should be false):', movedWhileHeld);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);
const posAfterClose = await page.evaluate(() => window.__testShopAvatarPosition());
await page.waitForTimeout(700);
const posLater = await page.evaluate(() => window.__testShopAvatarPosition());
const drifted = Math.hypot(posLater.x - posAfterClose.x, posLater.y - posAfterClose.y) > 0.01;
console.log('avatar drifted after the modal closed (no stuck input; should be false):', drifted, posBeforeHold);

// 3) Next page: the avatar is back at the start of the new page, and the pager
// label moved on.
await page.keyboard.down('KeyD');
await page.waitForTimeout(400);
await page.keyboard.up('KeyD');
const posBeforeNext = await page.evaluate(() => window.__testShopAvatarPosition());
await page.click('#seller-showcase-next-btn');
await page.waitForFunction(() => /Page 2 of/.test(document.getElementById('seller-showcase-page-label').textContent), null, { timeout: 15000 });
await page.waitForTimeout(1500);
const posAfterNext = await page.evaluate(() => window.__testShopAvatarPosition());
const boundsAfterNext = await page.evaluate(() => window.__sellWorldGroundBounds());
const backAtStart = Math.abs(posAfterNext.x) < 0.5 && posAfterNext.y < boundsAfterNext.minY + 1.5 &&
  Math.hypot(posAfterNext.x - posBeforeNext.x, posAfterNext.y - posBeforeNext.y) > 0.05;
console.log('after Next the avatar is back at the start of the new page (should be true):', backAtStart, posBeforeNext, posAfterNext, boundsAfterNext);
const clearAfterNext = await pagerClearOfHud('after Next');

const pass = multiPage && clearAtStart && tapped && rowExpanded &&
  hudUnderTapModal.every((v) => !v) && !movedWhileHeld && !drifted &&
  backAtStart && clearAfterNext && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3296: Sell world view keeps tap-to-Manage, paging and modal control working while walking',
  errors,
});
