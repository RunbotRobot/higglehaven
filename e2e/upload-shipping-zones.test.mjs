// #4601 (part of #4394): the upload wizard asks where a physical product ships, once, on the step that holds the
// price and the digital-good tick. Closed it reads "Ships worldwide"; opened, one tick per zone. A digital good has no
// shipping; nothing ticked is refused on that step; a restricted choice is what gets stored.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, openAddProductLeaf } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Upload Shipping Tester';
const PRODUCT = 'Zoned Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
const summary = () => page.locator('#upload-shipping-summary').textContent();
const summaryAtFirst = (await summary()).trim();
console.log('closed, the shipping line reads (should be "Ships worldwide"):', summaryAtFirst);
const zoneBoxesHiddenAtFirst = !(await page.locator('#upload-shipping-zones').isVisible());
console.log('the zone ticks are folded away until opened (should be true):', zoneBoxesHiddenAtFirst);

await page.fill('#upload-name', PRODUCT);
await page.fill('#upload-price', '5');
await page.click('#upload-shipping-summary');
const allZonesTicked = (await page.locator('#upload-shipping-zones input:checked').count()) === 8;
console.log('opened, all eight zones start ticked (should be true):', allZonesTicked);

// A digital good has no shipping settings.
await page.check('#upload-digital-good-checkbox');
const hiddenForDigital = !(await page.locator('#upload-shipping-details').isVisible());
console.log('a digital good hides the shipping choice (should be true):', hiddenForDigital);
await page.uncheck('#upload-digital-good-checkbox');
const backForPhysical = await page.locator('#upload-shipping-details').isVisible();
console.log('and it comes back for a physical product (should be true):', backForPhysical);

// Nothing ticked is refused on this step, with the choice left open.
for (const box of await page.locator('#upload-shipping-zones input').all()) await box.uncheck();
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForTimeout(500);
const refusal = (await page.locator('#upload-status').textContent())?.trim();
console.log('nothing ticked is refused where it is chosen (should say to choose a place):', refusal);
const stillOnFirstStep = await page.locator('#upload-step-dimensions').isHidden();
console.log('and the person is still on that step (should be true):', stillOnFirstStep);

// Keep the United States and Canada only; the line says so, and it is what gets stored.
await page.check('#upload-shipping-zones input[value="us"]');
await page.check('#upload-shipping-zones input[value="ca"]');
const summaryTwo = (await summary()).trim();
console.log('the line follows the ticks (should be "Ships United States and Canada"):', summaryTwo);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 45000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 45000 });
await page.waitForTimeout(500);
const { templates } = await page.evaluate(async () => (await fetch('/api/catalog?limit=100')).json());
const stored = templates.find((t) => t.name === PRODUCT);
console.log('stored metadata.shippingZones (should be ["us","ca"]):', JSON.stringify(stored?.metadata?.shippingZones));

// The same product in Sell's row: the panel opens on what was stored, and ticking everything again clears it.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const rowLine = (await row().locator('.seller-row-domestic-only').textContent())?.trim();
console.log('the row says where it ships (should be "Ships: United States and Canada"):', rowLine);
await row().locator('.seller-more-settings-toggle').click();
await row().locator('button', { hasText: 'Edit shipping' }).click();
await page.waitForTimeout(300);
const ticked = await row().locator('.seller-shipping-zone-label input:checked').evaluateAll((boxes) => boxes.map((box) => box.value));
console.log('the panel opens on the stored zones (should be ["us","ca"]):', JSON.stringify(ticked));
for (const box of await row().locator('.seller-shipping-zone-label input').all()) await box.check();
await row().locator('button', { hasText: 'Save shipping' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-domestic-only-status')).some((el) => el.textContent === 'Saved.'),
  null,
  { timeout: 30000 },
);
const afterAll = (await page.evaluate(async () => (await fetch('/api/catalog?limit=100')).json())).templates.find((t) => t.name === PRODUCT);
console.log('ticking every zone stores nothing (should be undefined):', afterAll?.metadata?.shippingZones);
const rowLineAfter = (await row().locator('.seller-row-domestic-only').textContent())?.trim();
console.log('and the row reads (should be "Ships: worldwide"):', rowLineAfter);

const pass = summaryAtFirst === 'Ships worldwide' && zoneBoxesHiddenAtFirst && allZonesTicked
  && hiddenForDigital && backForPhysical
  && /at least one place/.test(refusal ?? '') && stillOnFirstStep
  && summaryTwo === 'Ships United States and Canada'
  && JSON.stringify(stored?.metadata?.shippingZones) === '["us","ca"]'
  && rowLine === 'Ships: United States and Canada' && JSON.stringify(ticked) === '["us","ca"]'
  && afterAll?.metadata?.shippingZones === undefined && rowLineAfter === 'Ships: worldwide'
  && errors.length === 0;
await finish(browser, { pass, label: '#4601: the upload wizard asks where a physical product ships, once, and refuses none', errors });
