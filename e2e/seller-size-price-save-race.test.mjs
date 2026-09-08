// Regression test found via backlog exploration: renderSellerList()'s
// metadataSaveBusyByTemplateId guard already serializes Digital Good /
// Returns Policy / Shipping / Extensibility / Flooring saves against each
// other (see #457) because they all PATCH the same catalog_templates row
// through a server handler that reads-existing/merges/rewrites every
// column, not just the one field a caller intended to touch — but Save
// Size and Save Price were never wired into that same guard despite
// hitting the identical endpoint. Two overlapping saves (Size, then Price
// before Size's own rescale-and-PATCH round trip finished) could silently
// clobber each other: whichever response landed last would overwrite the
// other field back to its pre-edit value. This confirms Save Price is
// disabled for the whole window Save Size's real network round trip is in
// flight, and that both edits land correctly once done sequentially.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Save Race Tester';
const PRODUCT_NAME = 'Save Race Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '10.00');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);

// Open both Edit Size and Edit Price at once — independent panels, no
// mutual-exclusion between them, same as a real seller could do.
await row().locator('button', { hasText: 'Edit Size' }).click();
await row().locator('button', { hasText: 'Edit Price' }).click();
await page.waitForTimeout(300);

const xInput = row().locator('.seller-size-row').nth(0).locator('input');
const xBefore = Number(await xInput.inputValue());
const newX = Number((xBefore * 2).toFixed(2));
await xInput.fill(String(newX));
await xInput.dispatchEvent('input');
await page.waitForTimeout(200);

// Kick off Save Size — a real uploaded model means this does a genuine
// fetch-rescale-reupload round trip before its own PATCH, giving a real
// window during which the guard should hold Save Price disabled.
await row().locator('button', { hasText: 'Save Size' }).click();
await page.waitForTimeout(100);
const pricebtnDisabledWhileSizeSaving = await row().locator('.seller-price-save-btn').isDisabled();
console.log('Save Price disabled while Save Size is still in flight (should be true):', pricebtnDisabledWhileSizeSaving);

await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-size-status')).some((el) => el.textContent.includes('notified')),
  { timeout: 20000 },
);
const priceBtnReenabledAfter = !(await row().locator('.seller-price-save-btn').isDisabled());
console.log('Save Price re-enabled once Save Size finished (should be true):', priceBtnReenabledAfter);

await row().locator('.seller-price-input').fill('7.99');
await row().locator('button', { hasText: 'Save Price' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-price-status')).some((el) => el.textContent === 'Saved.'),
  { timeout: 10000 },
);

const { templates } = await page.evaluate(async () => {
  const res = await fetch('/api/catalog?limit=100');
  return res.json();
});
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('server-side width after Save Size (should be ~2x original, not reverted by the Price save):', template?.dimensions?.width, 'vs original', xBefore);
console.log('server-side priceCents after Save Price (should be 799, not reverted by the Size save):', template?.priceCents);

const widthKept = Math.abs(template?.dimensions?.width - newX) < 0.05;
const priceKept = template?.priceCents === 799;

const pass = pricebtnDisabledWhileSizeSaving && priceBtnReenabledAfter && widthKept && priceKept && errors.length === 0;
await finish(browser, { pass, label: 'Save Size and Save Price on the same product are serialized, neither clobbers the other', errors });
