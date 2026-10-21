// #2438 investigation: loadModelGltf's own cache (src/main.js) used to cache
// a REJECTED load promise just as permanently as a resolved one -- a single
// transient failure (a dropped request, an R2 read racing right behind the
// upload that created this exact file) poisoned that modelUrl for the rest
// of the tab's session, since every later caller for the same URL (a second
// placed instance of the same template, a later view of the same product)
// got handed the identical already-rejected promise instead of a fresh
// attempt. The real-world report this traces to -- the imported avatar
// product "Avatar — Green Garbed Delivery Man" rendering correctly in Build
// mode and the seller's own products grid but as a plain gray box in Shop
// mode -- fits this shape exactly: whichever view got hit first, right after
// upload, while this one-off failure window was live, stayed poisoned for
// that session; a later view (a fresh tab, or simply after the failure had
// passed) never saw the problem at all, because it never shared the first
// session's cache.
//
// Reproduced here without any Shop-mode-specific machinery: place two
// separate instances of the SAME template (so both share one modelUrl) in
// Build mode, forcing only the very first network GET for that model to
// fail. Before the fix, both instances fall back to the colored box -- the
// second placement reuses the first's cached rejection exactly as if it had
// failed too, even though nothing forced its own fetch to fail. After the
// fix (loadModelGltf deletes its own cache entry the moment the promise it
// cached rejects), only the first placement's load actually fails; the
// second gets a genuinely fresh fetch and renders the real model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Model Retry Suite Tester';
const PRODUCT_NAME = 'Retry Suite Test Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

await chooseIdentity(page, { mode: 'build', label: LABEL });
await claimLandlet(page);

// createMeshForInstance's own box-fallback branch logs this exact warning
// (console.warn, not console.error -- helpers.mjs's own `errors` array only
// ever captures 'error'-typed console messages, so this needs its own
// listener) every time a model load throws and it falls back to a colored
// box. Counting it directly is a more precise signal than inspecting scene
// geometry: it fires only on the box-fallback path, never on a successful
// model load.
const boxFallbackWarnings = [];
page.on('console', (msg) => {
  if (msg.type() === 'warning' && msg.text().includes('falling back to a colored box')) boxFallbackWarnings.push(msg.text());
});

async function fetchJson(pathAndQuery) {
  return page.evaluate(async (p) => (await fetch(p)).json(), pathAndQuery);
}
const { templates } = await fetchJson('/api/catalog?limit=100');
const template = templates.find((t) => t.name === PRODUCT_NAME);

// The forced abort below logs its own browser-level console error
// ("Failed to load resource: net::ERR_FAILED" -- Chromium's own message,
// not anything this app's code produces, same as
// e2e/review-empty-state-stale-error.test.mjs's own route interception
// documents for its identical shape). Snapshotting here, before triggering
// it, means the final pass check can tell that one *expected* error apart
// from any other, genuinely unexpected one.
const errorsBeforeFailureSimulation = [...errors];

// Force only the very first GET to this model's own file to fail -- every
// later request for the exact same URL (including the second placement
// below) goes through untouched. Same "count then abort once" shape
// e2e/review-empty-state-stale-error.test.mjs's own route interception
// already uses for an unrelated endpoint.
let modelFetchCount = 0;
await page.route(`**${template.modelUrl}`, async (route) => {
  modelFetchCount++;
  if (modelFetchCount === 1) {
    await route.abort('failed');
    return;
  }
  await route.continue();
});

async function placeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

await placeAt(160, 400);
const warningsAfterFirst = boxFallbackWarnings.length;
console.log('box-fallback warnings after the first placement (forced failure, expect exactly 1):', warningsAfterFirst);

await placeAt(260, 400);
const warningsAfterSecond = boxFallbackWarnings.length;
console.log('box-fallback warnings after the second placement (same model, untouched by the route handler, should load for real — still expect exactly 1):', warningsAfterSecond);

const newErrors = errors.slice(errorsBeforeFailureSimulation.length);
const pass = warningsAfterFirst === 1 && warningsAfterSecond === 1
  && newErrors.length === 1 && newErrors[0].includes('net::ERR_FAILED');
await finish(browser, {
  pass,
  label: '#2438: a failed model load must not permanently poison that URL for the rest of the tab\'s session',
  errors,
});
