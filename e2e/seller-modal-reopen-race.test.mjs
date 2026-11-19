// Regression test for #457: renderSellerList() used to keep its
// metadata-save busy flag (see #424's own cross-panel save-race guard) as a
// plain local variable inside each row's per-render closure. Since
// openSellerModal() calls renderSellerList() fresh every time the modal
// opens, closing the modal while a metadata save was still in flight and
// reopening it produced a brand-new row with the busy flag reset to false —
// silently re-enabling the exact overlapping-save clobber #424 was added to
// prevent, and (in this fix's own additional gap) leaving that reopened
// row's buttons stuck disabled forever once the stale save's `finally`
// block only had a reference to the OLD, now-detached row's buttons to
// re-enable.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, openMyProducts, openAddProductLeaf } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller Reopen Race Tester';
const PRODUCT_NAME = 'Reopen Race Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await openAddProductLeaf(page);
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

const productRow = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await productRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);

// Hold only the PATCH (the save) until this test releases it, same shape as
// digital-goods.test.mjs's own cross-panel race test. #3718: this used to
// delay the PATCH by a fixed 3 s, then 6 s (#3700), and every time the
// close, reopen and open-the-row steps (two taps of the bud, #3699) ran
// longer than the hold on a loaded runner, the save had already landed
// before the check looked for it still being in flight. A held save stays
// in flight exactly as long as the test needs it to, however slow the runner.
let releaseSave;
const saveGate = new Promise((resolve) => { releaseSave = resolve; });
await page.route('**/api/catalog/*', async (route) => {
  if (route.request().method() === 'PATCH') await saveGate;
  await route.continue();
});

await productRow().locator('button', { hasText: 'Edit digital good' }).click();
await page.waitForTimeout(200);
await productRow().locator('.seller-digital-good-checkbox-label input').check();
await productRow().locator('.seller-digital-good-select').selectOption('gift-card');
await productRow().locator('button', { hasText: 'Save digital good' }).click();

// Close the modal (real user behavior — nothing in-flight is canceled by
// this, see closeSellerModal's own comment on why: it only toggles a CSS
// class) before the delayed PATCH above resolves, then reopen it. #540
// made Sell a genuine currentMode (a real reload on entry) rather than a
// modal overlay, so re-clicking the Sell nav tab while already in Sell
// mode is now a no-op — reopening goes through the showcase's own
// "Manage Products" button instead, same as seller-list-view.test.mjs.
await page.waitForTimeout(200);
await page.click('#seller-close-btn');
await page.waitForTimeout(200);
await openMyProducts(page);
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

// A brand-new row — renderSellerList() rebuilt it from scratch on reopen.
await productRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(200);

// Deliberately targets the "Save returns policy" button, not the "Save
// Digital Good" one the pre-close save was for — proving the busy state is
// serializing across EVERY metadata panel on this row, the same cross-panel
// guard #424 added, not just re-disabling the one button that happened to
// be clicked.
await productRow().locator('button', { hasText: 'Edit returns policy' }).click();
await page.waitForTimeout(200);
const reopenedSaveDisabledWhileStillInFlight = await productRow().locator('button', { hasText: 'Save returns policy' }).isDisabled();
console.log('a DIFFERENT metadata-save button on the REOPENED row is disabled while the pre-close save is still in flight (should be true — the #457 fix):', reopenedSaveDisabledWhileStillInFlight);

// Release the held PATCH and wait for its `finally` block to run: the button
// comes back (polled, not a fixed wait, so a slow runner cannot cut it short).
releaseSave();
const saveReturnsButton = productRow().locator('button', { hasText: 'Save returns policy' });
for (let i = 0; i < 60 && !(await saveReturnsButton.isEnabled()); i++) await page.waitForTimeout(500);

const reopenedSaveReenabledAfterSettling = await productRow().locator('button', { hasText: 'Save returns policy' }).isEnabled();
console.log('that same button is enabled again once the pre-close save actually resolves (should be true — not stuck disabled forever):', reopenedSaveReenabledAfterSettling);

await page.unroute('**/api/catalog/*');

// The pre-close save should have gone through correctly, and the row
// should accept a fresh save normally afterward — proving this isn't just
// "unstuck" but genuinely back to normal working order.
const { templates: templatesAfterFirstSave } = await page.evaluate(async () => (await fetch('/api/catalog?limit=100')).json());
const templateAfterFirstSave = templatesAfterFirstSave.find((t) => t.name === PRODUCT_NAME);
console.log('server-side metadata.digitalGoodDisclaimer after the pre-close save resolved (should be "gift-card"):', templateAfterFirstSave?.metadata?.digitalGoodDisclaimer);

// "Edit returns policy" is still open from the disabled-check above (its
// own toggle click was never closed) — clicking it again would close it
// instead, so the panel is used directly, same reasoning as
// digital-goods.test.mjs's own analogous comment.
await productRow().locator('.seller-no-returns-checkbox-label input').check();
await productRow().locator('button', { hasText: 'Save returns policy' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-no-returns-status')).some((el) => el.textContent === 'Saved.'),
  null,
  { timeout: 30000 },
);
const { templates: templatesAfterSecondSave } = await page.evaluate(async () => (await fetch('/api/catalog?limit=100')).json());
const templateAfterSecondSave = templatesAfterSecondSave.find((t) => t.name === PRODUCT_NAME);
console.log('a normal save on the reopened row afterward still works, and the earlier field survives it (digitalGoodDisclaimer should still be "gift-card", noReturns should be true):', templateAfterSecondSave?.metadata);

const pass = reopenedSaveDisabledWhileStillInFlight &&
  reopenedSaveReenabledAfterSettling &&
  templateAfterFirstSave?.metadata?.digitalGoodDisclaimer === 'gift-card' &&
  templateAfterSecondSave?.metadata?.digitalGoodDisclaimer === 'gift-card' &&
  templateAfterSecondSave?.metadata?.noReturns === true &&
  errors.length === 0;
await finish(browser, { pass, label: "#457: a metadata save left in flight across a Seller-modal close/reopen still serializes and un-sticks correctly", errors });
