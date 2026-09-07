// Digital goods (docs/SPEC.md §4: "Digital goods — narrow, conditional
// exception ... permitted if the listing includes ... a clear
// higglehaven-controlled disclaimer"). Covers the real upload wizard's
// checkbox+disclaimer picker round-tripping into the Seller modal's own
// "Edit Digital Good" panel.
//
// The prohibited-categories rejection (docs/SPEC.md §4's "weapons ...
// controlled substances ... adult content ... counterfeit ... live
// animals") is deliberately NOT exercised here even though the upload
// wizard is a real, reachable path to it — triggering that real rejected
// fetch from inside the page logs a "Failed to load resource" console
// error (plus this app's own console.error in the upload catch block) that
// would trip this suite's own errors.length === 0 check, the same
// reasoning already documented in community-signs.test.mjs and
// community-calendar.test.mjs for their own analogous 400 cases. The full
// prohibited-content and digital-good validation matrix (phrase matching,
// batch/PATCH paths, invalid disclaimer keys) is covered instead by
// worker/commerce.test.js's own "Prohibited categories and digital goods"
// describe block.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Content Policy Suite Tester';
const DIGITAL_PRODUCT = 'Suite Digital Gift Card';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

// A digital good, set at upload time via the checkbox + disclaimer picker.
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', DIGITAL_PRODUCT);
await page.check('#upload-digital-good-checkbox');
const disclaimerLabelVisibleAfterCheck = await page.locator('#upload-digital-good-disclaimer-label').isVisible();
console.log('disclaimer picker visible once the checkbox is checked (should be true):', disclaimerLabelVisibleAfterCheck);
await page.selectOption('#upload-digital-good-disclaimer-select', 'gift-card');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

const digitalRow = () => page.locator('.seller-row').filter({ hasText: DIGITAL_PRODUCT });
await digitalRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const digitalGoodRowText = await digitalRow().locator('.seller-row-digital-good').textContent();
console.log('digital-good row text right after upload (should mention "Digital good" and "gift"):', digitalGoodRowText);

// Persisted server-side as the raw key, not the display text.
const { templates } = await page.evaluate(async () => {
  const res = await fetch('/api/catalog?limit=100');
  return res.json();
});
const digitalTemplate = templates.find((t) => t.name === DIGITAL_PRODUCT);
console.log('server-side metadata.digitalGoodDisclaimer (should be "gift-card"):', digitalTemplate?.metadata?.digitalGoodDisclaimer);

// Clear it via the row's own "Edit Digital Good" panel.
await digitalRow().locator('button', { hasText: 'Edit Digital Good' }).click();
await page.waitForTimeout(300);
const checkboxCheckedInPanel = await digitalRow().locator('.seller-digital-good-checkbox-label input').isChecked();
console.log('Edit Digital Good panel opens pre-checked for an existing digital good (should be true):', checkboxCheckedInPanel);
await digitalRow().locator('.seller-digital-good-checkbox-label input').uncheck();
await digitalRow().locator('button', { hasText: 'Save Digital Good' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-digital-good-status')).some((el) => el.textContent === 'Saved.'),
  { timeout: 10000 },
);
const digitalGoodRowTextAfterClear = await digitalRow().locator('.seller-row-digital-good').textContent();
console.log('digital-good row text after unchecking + saving (should be "Not a digital good"):', digitalGoodRowTextAfterClear);

// Cross-panel metadata-save race guard (issue #424): "Edit Digital Good"
// and "Edit Shipping" independently spread-and-replace the whole
// template.metadata object (see either save handler's own comment on the
// server doing a full replace, not a merge), so saving both in an
// overlapping window used to let whichever response landed last silently
// discard the other panel's just-saved change. Delaying the Shipping
// PATCH here (the only one of the two that actually mutates the record —
// nothing else on this page issues any other PATCH to this template
// concurrently, so this is the only in-flight request the delay needs to
// distinguish from) makes the race's timing window reliably observable
// instead of depending on real network jitter.
await page.route('**/api/catalog/*', async (route) => {
  if (route.request().method() === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 800));
  await route.continue();
});
await digitalRow().locator('button', { hasText: 'Edit Shipping' }).click();
await page.waitForTimeout(300);
await digitalRow().locator('.seller-domestic-only-checkbox-label input').check();
// "Edit Digital Good" is still open from earlier in this test (its own
// toggle click above never closed it) — clicking the toggle again here
// would close it instead of opening it, so just use the panel directly.
await digitalRow().locator('.seller-digital-good-checkbox-label input').check();
await digitalRow().locator('.seller-digital-good-select').selectOption('gift-card');
await digitalRow().locator('button', { hasText: 'Save Shipping' }).click();
const digitalGoodSaveDisabledMidFlight = await digitalRow().locator('button', { hasText: 'Save Digital Good' }).isDisabled();
console.log('Save Digital Good disabled while Save Shipping request is in flight (should be true):', digitalGoodSaveDisabledMidFlight);
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-domestic-only-status')).some((el) => el.textContent === 'Saved.'),
  { timeout: 10000 },
);
await digitalRow().locator('button', { hasText: 'Save Digital Good' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-digital-good-status')).some((el) => el.textContent === 'Saved.'),
  { timeout: 10000 },
);
await page.unroute('**/api/catalog/*');
const afterRace = await page.evaluate(async () => {
  const res = await fetch('/api/catalog?limit=100');
  return res.json();
});
const raceTemplate = afterRace.templates.find((t) => t.name === DIGITAL_PRODUCT);
console.log('after the cross-panel race, metadata.domesticOnly (should be true — not silently reverted):', raceTemplate?.metadata?.domesticOnly);
console.log('after the cross-panel race, metadata.digitalGoodDisclaimer (should be "gift-card"):', raceTemplate?.metadata?.digitalGoodDisclaimer);

const pass = disclaimerLabelVisibleAfterCheck &&
  digitalGoodRowText.includes('Digital good') && digitalGoodRowText.toLowerCase().includes('gift') &&
  digitalTemplate?.metadata?.digitalGoodDisclaimer === 'gift-card' &&
  checkboxCheckedInPanel &&
  digitalGoodRowTextAfterClear.trim() === 'Not a digital good' &&
  digitalGoodSaveDisabledMidFlight &&
  raceTemplate?.metadata?.domesticOnly === true &&
  raceTemplate?.metadata?.digitalGoodDisclaimer === 'gift-card' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Digital-good upload/edit round-trip via the Seller modal', errors });
