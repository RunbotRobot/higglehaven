// #329/#330: Prompt mode — the frontend entry point that turns a builder's
// free-text prompt into a concept image (#328), embeds it client-side (the
// same cheap stand-in every catalog thumbnail already uses), and searches
// the catalog for similar products (#329's own backend half, already
// merged) — picking a result arms placement mode through the exact same
// flow Manual mode's own tiles already use (#330).
//
// This env never configures OPENAI_API_KEY (see docs/API.md's own testing
// note on POST /api/catalog/concept-image), and worker/commerce.test.js's
// own "Prompt-mode concept-image generation" describe block already covers
// that endpoint's real behavior up to and including the 503 it returns
// when unconfigured — deliberately not re-triggering that same real
// non-2xx response here, since Chrome logs "Failed to load resource" for
// any failed fetch regardless of whether the app handles it gracefully,
// which would trip this suite's own errors.length === 0 check (same
// reasoning documented in auth.test.mjs and elsewhere in this suite).
// Instead, the concept-image call is routed to a fake-but-real success
// response so the rest of the pipeline — embedding, similarity-search,
// results, click-to-place — runs for real against the actual backend.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Prompt Mode Tester';
const PRODUCT_NAME = 'Prompt Match Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// A real uploaded-and-thumbnailed product is what similarity-search has to
// actually match against — a fresh e2e database starts with zero
// image_embedding rows (only ever set by the thumbnail-persist endpoint),
// so without this, similarity-search would have nothing to find no matter
// how the rest of this flow behaves.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

// #327: persistCatalogThumbnail (which is what actually stores the
// embedding similarity-search reads) is fire-and-forget from the upload
// flow's own point of view — poll rather than assuming it's already
// landed, same as seller-upload-and-resize.test.mjs's own note on this.
await page.waitForFunction(
  async (name) => {
    const res = await fetch('/api/catalog?limit=100');
    const { templates } = await res.json();
    return Array.isArray(templates.find((t) => t.name === name)?.imageEmbedding);
  },
  PRODUCT_NAME,
  { timeout: 15000 },
);

// #540 made Sell a genuine currentMode (a real reload on entry), so
// closing the modal leaves the seller looking at their own showcase, not a
// live Build-mode scene underneath — switch back explicitly.
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#add-item-btn', { timeout: 15000 });
await page.waitForTimeout(500);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });

const manualActiveByDefault = await page.locator('.catalog-picker-mode-btn[data-picker-mode="manual"]').evaluate((el) => el.classList.contains('active'));
const promptSectionHiddenByDefault = await page.locator('#prompt-mode-section').isHidden();
console.log('Manual tab active by default (should be true):', manualActiveByDefault);
console.log('Prompt section hidden by default (should be true):', promptSectionHiddenByDefault);

await page.click('.catalog-picker-mode-btn[data-picker-mode="prompt"]');
const promptActiveAfterClick = await page.locator('.catalog-picker-mode-btn[data-picker-mode="prompt"]').evaluate((el) => el.classList.contains('active'));
const manualSectionHiddenAfterClick = await page.locator('#catalog-picker-manual-section').isHidden();
const promptSectionVisibleAfterClick = await page.locator('#prompt-mode-section').isVisible();
console.log('Prompt tab active after clicking it (should be true):', promptActiveAfterClick);
console.log('Manual section hidden once on Prompt (should be true):', manualSectionHiddenAfterClick);
console.log('Prompt section visible once on Prompt (should be true):', promptSectionVisibleAfterClick);

// Client-side guard — never reaches the network for a blank prompt.
await page.click('#prompt-mode-generate-btn');
const blankPromptStatus = await page.textContent('#prompt-mode-status');
console.log('status after clicking Generate with a blank prompt (should ask to describe something, not hit the network):', blankPromptStatus);

// Stand in for the real (unconfigured-in-this-env) image-gen call — any
// real, loadable same-origin image works, since what matters here is
// exercising the client-side embedding + similarity-search + render
// pipeline, not the generated image's actual content.
await page.route('**/api/catalog/concept-image', async (route) => {
  await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ imageUrl: '/wordmark.png' }) });
});

await page.fill('#prompt-mode-input', 'a cozy wooden park bench with wrought-iron armrests');
await page.click('#prompt-mode-generate-btn');
await page.waitForFunction(
  () => document.getElementById('prompt-mode-status').textContent.includes('match'),
  { timeout: 15000 },
);
const matchStatus = await page.textContent('#prompt-mode-status');
const statusIsNotError = await page.locator('#prompt-mode-status').evaluate((el) => !el.classList.contains('error'));
const generateReenabled = await page.isEnabled('#prompt-mode-generate-btn');
const conceptImageVisible = await page.locator('#prompt-mode-concept-image').isVisible();
const resultTiles = page.locator('#prompt-mode-results-grid .catalog-tile');
const resultCount = await resultTiles.count();
const resultText = resultCount > 0 ? await resultTiles.first().textContent() : '';
console.log('status once the (mocked) concept image + real similarity-search resolve (should mention a match):', matchStatus);
console.log('status not styled as an error (should be true):', statusIsNotError);
console.log('Generate button re-enabled once done (should be true):', generateReenabled);
console.log('concept image preview shown (should be true):', conceptImageVisible);
console.log('result count (should be 1 — only one product has an embedding at all):', resultCount);
console.log('result tile mentions the uploaded product (should be true):', resultText.includes(PRODUCT_NAME));

// Picking a result arms placement mode exactly like a Manual-mode tile
// does — the picker closes and #product-info shows the same placement
// prompt (#330's own "reuse the existing flow, don't duplicate it" goal).
await resultTiles.first().click();
const pickerClosedAfterPick = await page.locator('#catalog-picker.visible').count();
const productInfoAfterPick = await page.textContent('#product-info');
console.log('picker closed after picking a Prompt-mode result (should be 0):', pickerClosedAfterPick);
console.log('placement armed for the picked product (should mention its name):', productInfoAfterPick);

const pass = manualActiveByDefault && promptSectionHiddenByDefault &&
  promptActiveAfterClick && manualSectionHiddenAfterClick && promptSectionVisibleAfterClick &&
  !!blankPromptStatus && !blankPromptStatus.toLowerCase().includes('match') &&
  matchStatus.includes('match') && statusIsNotError && generateReenabled && conceptImageVisible &&
  resultCount === 1 && resultText.includes(PRODUCT_NAME) &&
  pickerClosedAfterPick === 0 && productInfoAfterPick.includes(PRODUCT_NAME) &&
  errors.length === 0;
await finish(browser, { pass, label: '#329/#330: Prompt mode — tab switching, blank-prompt guard, real embed+search pipeline, click-to-place', errors });
