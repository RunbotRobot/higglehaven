// Regression test for #425: the Seller modal's Sales panel had no
// stale-response guard, unlike its sibling sign-posts/calendar-events
// panels — a slow first fetch resolving after a faster, fresher second
// one could silently overwrite the panel with stale data. Delays the
// first GET /api/purchases via Playwright route interception to get a
// deterministic reordering, matching the exact repro in the issue.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Sales Panel Race Tester';
const PRODUCT_NAME = 'Race Panel Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
// #1930: 10000ms was tight enough to intermittently time out under CI
// load here (and at every other '#seller-modal.visible' wait across the
// e2e suite, all bumped to this same 30000ms in the same pass) -- same
// post-identity-switch margin-under-contention class as #1388/#1896's
// '#auth-modal' wait in chooseIdentity, which this now matches.
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '40');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
// #2145 (sub-issue of #2138): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real
// applied timeout was always Playwright's actual default (30000ms), never
// the smaller number written here. The explicit `null` arg reaches the
// options slot, and the timeout itself is widened to 60000ms for real
// headroom under CI load, same as e2e/helpers.mjs's own account-menu-modal
// wait.
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 60000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 60000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded, priced product found in catalog:', !!template);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];
const instanceId = 'sales-race-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

// #653: the simulated path is now admin-only (this seller hasn't
// completed Stripe Connect onboarding) — grant it to this same
// browser-session account now, before the race below starts, so the
// purchase fetch mid-race stays an ordinary single request rather than
// picking up an extra grant-admin round trip that could itself perturb
// the timing this test depends on.
await grantAdmin(emailForLabel(LABEL));

// Delay only the first GET /api/purchases (the initial, still-empty
// fetch) so it resolves *after* a real purchase is created and a second,
// unfiltered GET fires — the exact reordering the issue describes.
let getPurchasesCount = 0;
await page.route('**/api/purchases*', async (route) => {
  if (route.request().method() === 'GET') {
    getPurchasesCount++;
    if (getPurchasesCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  await route.continue();
});

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-sales-toggle').click(); // fires the slow, still-empty GET #1

// A real sale lands while GET #1 is still in flight.
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyerLabel: 'A Race Shopper' }),
});
console.log('purchase created while the first Sales fetch was still in flight (status should be 201):', purchased.status);

// Close and reopen before GET #1 resolves — fires a fresh, fast GET #2
// that should win, showing the sale GET #1 never knew about.
await row().locator('.seller-sales-toggle').click();
await page.waitForTimeout(200);
await row().locator('.seller-sales-toggle').click();
await page.waitForTimeout(2500); // long enough for GET #1's delayed response to land too

const saleRowCount = await row().locator('.product-sale-row').count();
const emptyVisible = await row().locator('.seller-sales-empty').isVisible();
console.log('sale rows shown after GET #1 (stale, empty) lands last (should be 1, not reverted to 0):', saleRowCount);
console.log('"No sales yet" empty state visible (should be false):', emptyVisible);

const pass = saleRowCount === 1 && !emptyVisible && errors.length === 0;
await finish(browser, { pass, label: '#425: a slow, stale Sales fetch does not overwrite a fresher reopen', errors });
