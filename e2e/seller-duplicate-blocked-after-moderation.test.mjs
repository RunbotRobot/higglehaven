// #2218 (owner decision, 2026-10-25): once an admin approves a counterfeit/
// policy flag on a seller's listing (catalog_templates.flagged_hidden_at
// set -- see worker/product-flags.test.js's own flag/resolve coverage),
// the seller's own "Duplicate" button used to have no awareness of that at
// all -- a one-click way to spin up a fresh, unflagged copy, undoing the
// admin's removal. The owner's decision: keep the listing visible in "My
// Products" (never hidden/deleted) with a clear "Removed — policy
// violation" indicator, and disable Duplicate for it client-side (the
// server-side sourceTemplateId rejection -- "not just a UI-level block" --
// is covered separately by worker/product-flags.test.js's own new
// "(#2218)" describe block, not here: deliberately triggering that real
// 403 through the browser's own fetch would trip this suite's shared
// errors.length === 0 check, since Chrome logs "Failed to load resource"
// for any non-2xx response regardless of whether the app handled it
// gracefully -- same reasoning e2e/auth.test.mjs's own header comment
// documents for an identical rejection-path call it also leaves to its
// vitest sibling instead). This drives the two client-visible pieces
// through the real UI, setting flagged_hidden_at directly via `wrangler
// d1 execute --local` -- the only way to reach this state here without
// standing up multiple real flagger builder sessions.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Duplicate Moderation Tester';
const PRODUCT_NAME = 'Duplicate Moderation Product';

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

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded product found (should be true):', Boolean(template));

// The one way to reach flagged_hidden_at here without three real flagger
// builder sessions -- see this file's own header comment.
execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'higglehaven-db', '--local', '--command',
  `UPDATE catalog_templates SET flagged_hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE template_id = '${template.templateId}'`,
], { cwd: REPO_ROOT, stdio: 'pipe' });

// A raw reload lands in Shop mode by default unless this is set first --
// see e2e/bundle-rename-sync.test.mjs's own identical comment.
await page.evaluate(() => sessionStorage.setItem('higglehaven.startMode', 'sell'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

const row = page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);

const manageBadgeText = await row.locator('.seller-row-flagged-badge').textContent();
console.log('Manage-view badge text (should mention policy violation):', manageBadgeText);
const duplicateDisabled = await row.locator('.seller-row-action-btn', { hasText: 'Duplicate' }).isDisabled();
console.log('Duplicate button disabled in Manage view (should be true):', duplicateDisabled);

await page.click('.seller-view-btn[data-view="list"]');
await page.waitForTimeout(300);
const card = page.locator('.seller-card').filter({ hasText: PRODUCT_NAME });
const listBadgeText = await card.locator('.seller-card-flagged-badge').textContent();
console.log('List-view badge text (should mention policy violation):', listBadgeText);

const pass =
  Boolean(template) &&
  /policy violation/i.test(manageBadgeText || '') &&
  duplicateDisabled &&
  /policy violation/i.test(listBadgeText || '') &&
  errors.length === 0;

await finish(browser, {
  pass,
  label: 'Seller Duplicate button is disabled, and a "Removed" badge shown in both views, for an admin-removed listing (#2218)',
  errors,
});
