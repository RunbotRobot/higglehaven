// #4437: a product's thumbnail and the 8x8 grid Prompt mode matches on are stored only when its seller's own browser sends
// them right after an upload; a call that was missed was never made again, so the product could never be found by Prompt
// mode. Here the thumbnail request is made to fail while a product is uploaded (the missed call), then, in a fresh page,
// opening My products sends the missing one: the stored product gets an image and a 192-value grid. 390x844.
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish, goToMode, openAddProductLeaf } from './helpers.mjs';

const LABEL = 'Thumbnail Backfill Tester';
const NAME = 'Backfill Crate';
const CRATE_MODEL_PATH = fileURLToPath(new URL('../public/models/crate.glb', import.meta.url));
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });

// The missed call: every thumbnail upload fails while the product is made.
await page.route('**/api/catalog/*/thumbnail', (route) => route.abort('failed'));
await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const readProduct = () => page.evaluate(async (name) => {
  const { templates } = await (await fetch('/api/catalog?limit=100')).json();
  const t = templates.find((x) => x.name === name);
  return t ? { imageUrl: t.imageUrl, embeddingLength: t.imageEmbedding?.length ?? 0 } : null;
}, NAME);
const before = await readProduct();
console.log('the product exists and has no stored thumbnail (should be true):', !!before && !before.imageUrl, JSON.stringify(before));

// A fresh page, with thumbnails working again: opening My products sends the missing one.
await page.unroute('**/api/catalog/*/thumbnail');
await page.reload({ waitUntil: 'networkidle' });
await goToMode(page, 'sell');
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
let after = null;
for (let i = 0; i < 40; i += 1) {
  after = await readProduct();
  if (after?.imageUrl) break;
  await page.waitForTimeout(500);
}
console.log('after opening My products the product has an image and a grid (should be true):', JSON.stringify(after));

const pass = !!before && !before.imageUrl && !!after?.imageUrl && after.embeddingLength === 192;
await finish(browser, { pass, label: '#4437: opening My products stores the thumbnail and grid a product is missing', errors: errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_FAILED') && !e.includes('could not persist a thumbnail')) });
