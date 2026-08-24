// Ground/flooring products (docs/SPEC.md §3) — a seller-owned product
// marked "Flooring" via the Seller modal toggle always renders and places
// as a thin flat slab flush with the ground, regardless of where it's
// tapped or how its Move gizmo's Z arrow is dragged.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Flooring Suite Tester';
const PRODUCT_NAME = 'Suite Sod';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

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

// Mark it as flooring.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const flooringToggleBefore = await row().locator('button', { hasText: 'Flooring' }).textContent();
console.log('flooring toggle label before (should be plain "Flooring"):', flooringToggleBefore);
await row().locator('button', { hasText: 'Flooring' }).click();
await page.waitForTimeout(500);
const flooringToggleAfter = await row().locator('button', { hasText: 'Flooring' }).textContent();
console.log('flooring toggle label after (should include a checkmark):', flooringToggleAfter);

await page.click('#seller-close-btn');
await page.waitForTimeout(300);

// Place it by tapping directly on top of another already-placed item —
// flooring should still land at true ground level, not on top of
// whatever was tapped.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
await page.waitForTimeout(300);
// Tap right on the tree's own screen position — a normal item placed here
// would rest on TOP of the tree; flooring should ignore that and sit at
// the ground instead.
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

// Read back the actual persisted instances to confirm the flooring one's
// z is pinned to the thin ground thickness, not resting on the tree it
// was tapped onto. A fresh local D1 (see e2e/run-all.mjs) only ever seeds
// one claimable landlet — "starter-landlet" — which claimLandlet() above
// always ends up claiming, so it's safe to name directly here.
const instances = await page.evaluate(async () => {
  const res = await fetch('/api/instances?landletId=starter-landlet&limit=100');
  const body = await res.json();
  return body.instances;
});
console.log('placed instances:', instances.map((i) => ({ template: i.templateId, x: i.x, y: i.y, z: i.z })));
const flooringInstance = instances.find((i) => i.z > 0 && i.z < 0.05);
console.log('flooring instance z (should be ~0.01, not resting on the tree):', flooringInstance?.z);
const zIsGroundLevel = flooringInstance !== undefined;

const pass = flooringToggleBefore.trim() === 'Flooring' &&
  flooringToggleAfter.includes('✓') &&
  zIsGroundLevel &&
  errors.length === 0;
await finish(browser, { pass, label: 'ground/flooring products place at true ground level', errors });
