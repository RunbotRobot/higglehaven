// #540: Sell mode's "faux lándlet" 3D array — the owner-confirmed design
// (Control Room): real placed-instance meshes (not thumbnails) for the
// seller's own products, a pager once closing the modal reveals the
// showcase behind it, and clicking a product jumps straight to Manage with
// that product's row expanded. Pagination-by-file-size math itself is
// covered by src/sellerShowcase.test.js (a pure unit test) — this covers
// only the real frontend wiring: the showcase actually renders, the pager
// shows up once the modal is closed, and a click on a showcase item does
// the right thing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

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
console.log('"Manage Products" button visible once the modal is closed (should be true):', manageBtnVisible);

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

const pass = pagerVisibleWhileModalOpen && pageLabelWhileModalOpen === 'Page 1 of 1' &&
  pagerVisibleAfterClose && manageBtnVisible && prevDisabled && nextDisabled &&
  opened && modalOnManageAfterClick && someRowExpanded >= 1 &&
  errors.length === 0;
await finish(browser, { pass, label: '#540: Sell mode showcase array — pager, and click-to-Manage on a real placed-instance mesh', errors });
