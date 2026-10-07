// #540: Sell mode's "faux lándlet" 3D array — the owner-confirmed design
// (Control Room): real placed-instance meshes (not thumbnails) for the
// seller's own products, a pager once closing the modal reveals the
// showcase behind it, and clicking a product jumps straight to Manage with
// that product's row expanded. Pagination-by-file-size math itself is
// covered by src/sellerShowcase.test.js (a pure unit test) — this covers
// only the real frontend wiring: the showcase actually renders, the pager
// shows up once the modal is closed, and a click on a showcase item does
// the right thing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

// Same default this file's own helpers.mjs uses internally (not exported) —
// kept in sync deliberately rather than importing it, since the plain
// Node-side fetches below (see uploadModel/seedHeavyTemplate) need it same
// as helpers.mjs's own adminApi does, for the same "don't share the real
// page's cookie jar" reason given there.
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const BENCH_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'bench.glb');
const TABLE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'table.glb');

const LABEL = 'Sell Showcase Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

async function uploadProduct(name) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
  await page.waitForTimeout(500);
}

await uploadProduct('Showcase Crate One');
await uploadProduct('Showcase Crate Two');

// Behind the modal (semi-transparent backdrop, index.html's own #seller-
// modal CSS), the pager should already reflect two small products safely
// under the per-page byte cap — one page.
const pagerVisibleWhileModalOpen = await page.locator('#seller-showcase-pager').isVisible();
const pageLabelWhileModalOpen = await page.textContent('#seller-showcase-page-label');
console.log('pager already visible behind the modal (should be true):', pagerVisibleWhileModalOpen);
console.log('page label with two small products (should be "Page 1 of 1"):', pageLabelWhileModalOpen);

await page.click('#seller-close-btn');
await page.waitForTimeout(500);

const pagerVisibleAfterClose = await page.locator('#seller-showcase-pager').isVisible();
const manageBtnVisible = await page.locator('#seller-showcase-manage-btn').isVisible();
console.log('pager visible once the modal is closed (should be true):', pagerVisibleAfterClose);
console.log('"Products" button visible once the modal is closed (should be true):', manageBtnVisible);

// Owner feedback N51: at this viewport width the centered pager pill and
// the right-anchored "Products" button used to visually overlap (the
// button's old, longer "Manage Products" label pushed its left edge into
// the pager's own horizontal centering). Checking real bounding boxes
// rather than eyeballing a screenshot, so a future label/CSS change that
// reintroduces the collision fails a real assertion.
const pagerBox = await page.locator('#seller-showcase-pager').boundingBox();
const manageBtnBox = await page.locator('#seller-showcase-manage-btn').boundingBox();
const rectsOverlap = pagerBox.x < manageBtnBox.x + manageBtnBox.width &&
  pagerBox.x + pagerBox.width > manageBtnBox.x &&
  pagerBox.y < manageBtnBox.y + manageBtnBox.height &&
  pagerBox.y + pagerBox.height > manageBtnBox.y;
console.log('pager and "Products" button overlap on screen (should be false):', rectsOverlap);

// Prev/Next are both disabled with only one page.
const prevDisabled = await page.isDisabled('#seller-showcase-prev-btn');
const nextDisabled = await page.isDisabled('#seller-showcase-next-btn');
console.log('Prev disabled on the only page (should be true):', prevDisabled);
console.log('Next disabled on the only page (should be true):', nextDisabled);

// Clicking a real placed-instance mesh in the showcase should jump straight
// to Manage with that product's own row expanded — scan a small grid of
// candidate canvas points (same "don't guess one fixed pixel" reasoning as
// helpers.mjs's own clickUntilSelected/claimLandlet) since the exact
// on-screen position of a showcase item depends on real model geometry
// this test doesn't hand-compute.
let opened = false;
for (const [fx, fy] of [[0.5, 0.55], [0.45, 0.5], [0.55, 0.5], [0.4, 0.55], [0.6, 0.55], [0.5, 0.45], [0.5, 0.6]]) {
  await page.mouse.click(420 * fx, 860 * fy);
  await page.waitForTimeout(300);
  if (await page.locator('#seller-modal.visible').isVisible()) { opened = true; break; }
}
console.log('clicking a showcase item opened the modal (should be true):', opened);
const modalOnManageAfterClick = await page.locator('#seller-list').isVisible();
const someRowExpanded = await page.locator('.seller-row.expanded').count();
console.log('reopened on Manage view (should be true):', modalOnManageAfterClick);
console.log('a product row is expanded after the click (should be >= 1):', someRowExpanded);

const firstSectionPass = pagerVisibleWhileModalOpen && pageLabelWhileModalOpen === 'Page 1 of 1' &&
  pagerVisibleAfterClose && manageBtnVisible && !rectsOverlap && prevDisabled && nextDisabled &&
  opened && modalOnManageAfterClick && someRowExpanded >= 1;

// #1427: loadSellerShowcasePage resolves a whole page's real product
// meshes via Promise.all before checking whether a newer page
// load (sellerShowcaseLoadToken) superseded it — the superseded branch
// used to just `return`, discarding every already-built mesh (geometry +
// material + textures) without ever disposing it. Forcing this race for
// real needs: (1) at least two showcase pages, so Next/Prev is actually
// clickable, and (2) a model fetch slow enough to reliably still be
// in-flight when the next click lands — a plain rapid double-click isn't
// enough on its own, since a same-tick box-mesh build (no model to fetch)
// resolves well within one microtask flush, long before even a fast
// Playwright click round-trip reaches the page.
//
// Two freshly-registered (never-before-fetched-by-this-browser) models are
// uploaded via a plain Node-side POST (same cookie-free, page-neutral
// `fetch` reasoning as helpers.mjs's own adminApi) so the actual showcase
// render below is the FIRST time either model's URL is ever requested —
// no risk of the immutable cache-control handleModelUpload sets on every
// upload serving a later request straight from the browser's HTTP cache
// and racing past our artificial delay unnoticed.
async function uploadModel(localPath) {
  const bytes = await fs.readFile(localPath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'model/gltf-binary' }), path.basename(localPath));
  const response = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: form });
  const body = await response.json();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`uploadModel(${localPath}) failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body; // { modelUrl, sizeBytes, ... }
}

const cookies = await page.context().cookies();
const sessionCookie = cookies.find((c) => c.name === 'hh_session');
const cookieHeader = sessionCookie ? `hh_session=${sessionCookie.value}` : '';

const { templates: ownTemplates } = await page.evaluate(
  async () => (await fetch('/api/catalog?limit=100')).json(),
);
const sellerId = ownTemplates.find((t) => t.name === 'Showcase Crate One')?.sellerId;

// SELLER_SHOWCASE_PAGE_BYTES_CAP (src/sellerShowcase.js) is 12MB — two 7MB
// declared sizes (14MB combined) guarantees at least one page break
// regardless of exactly where these land relative to the two tiny crates
// already uploaded above, without needing any file anywhere near that
// size for real (modelSizeBytes is trusted input, same as a legacy/
// pre-#540 template's already is).
async function seedHeavyTemplate(name, modelUrl) {
  const response = await fetch(`${BASE_URL}/api/catalog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      name, category: 'placeholder', color: '#887755',
      dimensions: { width: 1, depth: 1, height: 1 },
      sellerId, modelUrl, modelSizeBytes: 7 * 1024 * 1024,
    }),
  });
  const body = await response.json();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`seedHeavyTemplate(${name}) failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

const [benchUpload, tableUpload] = await Promise.all([uploadModel(BENCH_MODEL_PATH), uploadModel(TABLE_MODEL_PATH)]);
await seedHeavyTemplate('Showcase Heavy Filler A', benchUpload.modelUrl);
await seedHeavyTemplate('Showcase Heavy Filler B', tableUpload.modelUrl);

// #seller-modal (still open on Manage from the click-to-Manage check
// above) sits at a higher z-index than #mode-nav and covers it full-
// screen while open, so the mode-nav click below would silently hit the
// modal's own backdrop instead — close it first.
if (await page.locator('#seller-modal.visible').isVisible()) {
  await page.click('#seller-close-btn');
  await page.waitForTimeout(300);
}

// These two templates were created straight through the server API, not
// through the app's own upload flow (which pushes into the client's local
// activeCatalog itself, see uploadProduct() above) — nothing in the
// current page's memory knows about them yet. Switching away and back to
// Sell forces the same real reload + fetchCatalog() every ordinary mode
// entry already does (ties in with #540's "all three nav tabs are real
// reloads" comment further down this file), which is the only way this
// client ever learns about a product it didn't itself just create. Sell
// mode opens straight back into the product-management modal on entry
// (its own long-standing default — see this file's header comment), so
// close it once more before interacting with the showcase behind it.
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.click('#seller-close-btn');
await page.waitForTimeout(500);

const pageLabelBeforeRace = await page.textContent('#seller-showcase-page-label');
console.log('page label after seeding two 7MB-declared fillers (should be "Page 1 of 2" or similar — at least 2 pages):', pageLabelBeforeRace);
const multiPage = /Page 1 of [2-9]/.test(pageLabelBeforeRace || '');

const disposedCountBeforeRace = await page.evaluate(() => window.__sellerShowcaseDisposedMeshCount || 0);

// Delay every model fetch by a comfortable margin — only from here on, so
// the two tiny crates' own model fetches (already made once, during their
// normal initial showcase render just above) and the setup work above are
// never slowed down by this.
await page.route('**/uploads/**', async (route) => {
  if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 600));
  await route.continue();
});

// Next starts loading whichever page follows page 0 — its model fetch is
// the first-ever request for that page's own (never-before-fetched) model,
// so our artificial delay above reliably still has it in flight when...
await page.click('#seller-showcase-next-btn');
// ...Prev, clicked immediately after with no wait in between, bumps
// sellerShowcaseLoadToken again before that delayed fetch has any chance
// to resolve — exactly the supersede race #1427 describes.
await page.click('#seller-showcase-prev-btn');

// Comfortably past the artificial delay on both of the resulting in-flight
// loads, plus normal mesh-build margin.
await page.waitForTimeout(2000);
await page.unroute('**/uploads/**');

const disposedCountAfterRace = await page.evaluate(() => window.__sellerShowcaseDisposedMeshCount || 0);
console.log('superseded-page meshes disposed count before the race (baseline):', disposedCountBeforeRace);
console.log('superseded-page meshes disposed count after the race (should be greater — the #1427 fix):', disposedCountAfterRace);

const pageLabelAfterRace = await page.textContent('#seller-showcase-page-label');
console.log('page label settles back on page 1 after Next-then-Prev (should be "Page 1 of ..."):', pageLabelAfterRace);

const raceSectionPass = multiPage && disposedCountAfterRace > disposedCountBeforeRace &&
  (pageLabelAfterRace || '').startsWith('Page 1 of');

const pass = firstSectionPass && raceSectionPass && errors.length === 0;
await finish(browser, { pass, label: '#540/#1427: Sell mode showcase array — pager, click-to-Manage, and a superseded Next/Prev page load disposing its own just-built meshes instead of leaking them', errors });
