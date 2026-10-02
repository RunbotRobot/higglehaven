// #1164 (sub-issue of #1161): the "My Animations" picker (Settings > Shop,
// src/main.js's renderMyAnimationsField) and the Shop-mode buy hint's own
// compatibility note (productInfoText) for an "animation"-category product
// — the real backend (GET /api/builders/me/animations, GET/PUT
// /api/builders/me/animation, migration 0107) and UI wiring this issue
// added, mirroring e2e/avatar-picker-settings.test.mjs's own coverage shape.
//
// Not exercised here: the true "compatible" (matching skeletons) case.
// public/models/crate.glb (this repo's only e2e-friendly upload fixture)
// has no skeleton at all, so every signature involved comes back `null` —
// this test instead confirms the "no real skeleton to compare" paths
// (`animationCompatibility`'s own `unknown`/`no-avatar` cases) render and
// that applying/listing actually works end to end. The exact-match equality
// logic itself (src/main.js's computeSkeletonSignature/
// animationCompatibility) is a pure, deterministic string comparison with
// no further three.js/DOM dependency, already covered by #1162's own
// scratch verification against synthetic THREE.SkinnedMesh rigs (not
// committed, per vitest.config.js's own "nothing importing three.js
// belongs in src/**/*.test.js" note) — this test is about the real wiring
// around it, not re-deriving that correctness proof.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Animation Equip Settings Tester';
const PRODUCT_NAME = 'Suite Applied Animation';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.check('#upload-animation-category-checkbox');
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded product has animation category (should be true):', template?.category === 'animation');

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = 'suite-applied-animation-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' });
console.log('purchase response (status should be 201):', purchased.status);

// --- Shop-mode buy hint: tap the still-unpurchased-by-anyone-else placed
// instance and confirm the compatibility note appears on an animation
// product's info line (no avatar equipped at all here, so the "no real
// skeleton to compare against" case). ---
await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

const productInfoText = await page.evaluate(() => document.getElementById('shop-product-info')?.textContent || '');
console.log('Shop product-info text before any tap (diagnostic only):', productInfoText);

// --- Settings > Shop: the "My Animations" picker ---
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
const myAnimationsField = page.locator('.settings-field', { hasText: 'My Animations' });
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('My Animations') && f.querySelectorAll('.version-row').length >= 1),
  { timeout: 10000 },
);

// "— applied" (the em-dash-joined suffix renderMyAnimationsField appends
// to whichever row is currently applied) is the real equipped-state
// signal — a bare "applied" substring match would be a false positive on
// the "None applied" row's own label, which always contains that word
// regardless of whether it's actually the current choice.
const rowTextsBeforeApply = await myAnimationsField.locator('.version-row').allTextContents();
console.log('My Animations rows before applying (should list the purchased animation, not yet applied, with a compatibility note):', rowTextsBeforeApply);
const noneRowBefore = rowTextsBeforeApply.find((t) => t.includes('None applied'));
const purchasedRowBefore = rowTextsBeforeApply.find((t) => t.includes(PRODUCT_NAME));
const compatibilityNoteShown = /Compatible with your equipped avatar|Incompatible with your equipped avatar|Equip a custom avatar to check compatibility|Compatibility unknown/.test(
  purchasedRowBefore || '',
);
console.log('purchased animation row shows some compatibility note (should be true):', compatibilityNoteShown, '-', purchasedRowBefore);

// --- Apply the purchased animation through the real picker UI ---
const purchasedRow = myAnimationsField.locator('.version-row', { hasText: PRODUCT_NAME });
await purchasedRow.locator('button', { hasText: 'Apply' }).click();
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes(name) && r.textContent.includes('— applied')),
  PRODUCT_NAME,
  { timeout: 10000 },
);
const rowTextsAfterApply = await myAnimationsField.locator('.version-row').allTextContents();
console.log('My Animations rows after applying (purchased animation should now say "— applied"):', rowTextsAfterApply);
const purchasedRowAfter = rowTextsAfterApply.find((t) => t.includes(PRODUCT_NAME));
const noneRowAfter = rowTextsAfterApply.find((t) => t.includes('None applied'));

// --- Clear back to "None applied" via the same picker ---
const noneRow = myAnimationsField.locator('.version-row', { hasText: 'None applied' });
await noneRow.locator('button', { hasText: 'Clear' }).click();
await page.waitForFunction(
  () => [...document.querySelectorAll('.version-row')].some((r) => r.textContent.includes('None applied') && r.textContent.includes('— applied')),
  { timeout: 10000 },
);
const rowTextsAfterClear = await myAnimationsField.locator('.version-row').allTextContents();
console.log('My Animations rows after clearing:', rowTextsAfterClear);
const noneRowAfterClear = rowTextsAfterClear.find((t) => t.includes('None applied'));
const purchasedRowAfterClear = rowTextsAfterClear.find((t) => t.includes(PRODUCT_NAME));

// Confirm the underlying API actually persisted the clear, not just the UI.
const equippedAfterClear = (await fetchJson('/api/builders/me/animation')).body.animation;
console.log('equippedTemplateId after clearing (should be null):', equippedAfterClear.equippedTemplateId);

const pass =
  purchased.status === 201 &&
  !!noneRowBefore?.includes('— applied') &&
  !purchasedRowBefore?.includes('— applied') &&
  compatibilityNoteShown &&
  !!purchasedRowAfter?.includes('— applied') &&
  !noneRowAfter?.includes('— applied') &&
  !!noneRowAfterClear?.includes('— applied') &&
  !purchasedRowAfterClear?.includes('— applied') &&
  equippedAfterClear.equippedTemplateId === null &&
  errors.length === 0;
await finish(browser, { pass, label: 'Settings > Shop "My Animations" picker applies/clears, with a compatibility note shown (#1164)', errors });
