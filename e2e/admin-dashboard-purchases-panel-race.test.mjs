// #1928: the Admin Dashboard's Purchases (dangling-seller) panel load()
// (public/admin-dashboard.html) had no stale-response guard -- a slow
// manual Refresh click made shortly before a Mark Shipped action could
// resolve *after* that action's own internal load(), silently reverting the
// row back to its pre-action ("-") state. Same monotonic-token-guard fix
// shape as the sibling admin-dashboard-*-panel-race.test.mjs regression
// tests (#1878, #1909, #1910).
//
// Unlike those siblings, GET /api/purchases?danglingSeller=1 takes no
// distinguishing query param -- every request for this panel is identical,
// so the race here is forced by request *order* instead of by varying the
// URL: the 2nd GET fired (a manual Refresh) is delayed; the 3rd (fired by
// the Mark Shipped action's own success path) is not, so it resolves first.
//
// Seeding a real dangling-seller purchase needs a builder to claim land and
// place an instance of a seller's priced product, then purchase it (with
// simulatePaidPurchaseForTests: true for a real paymentIntentId --
// e2e/purchase-shipping.test.mjs's own recipe), then the seller deletes
// their account so the purchase's seller_id goes dangling. DELETE
// /api/sellers/:id itself refuses to delete a seller while any of their
// real-money purchases still has an unpaid balance (worker/index.js's own
// #732/#745 guard) -- by design, since this suite never configures
// STRIPE_SECRET_KEY, there's no real way through the app's own HTTP surface
// to pay that purchase out first (worker/index.js's handleSellerPayouts
// bails out at its own stripeConfigured check). worker/purchases.test.js's
// own "Seller deletion (#732)" vitest suite hits the identical wall and
// works around it with a direct `env.DB.prepare(...)` write standing in
// for what a real Stripe payout would have written; the one step below
// using `wrangler d1 execute --local` against this same e2e run's own local
// D1 is that exact workaround's equivalent from outside the Worker process
// -- paid_out_at/stripe_payout_id don't affect canMarkShipped (which this
// test still needs true) at all, only the deletion guard.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import {
  launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish,
} from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const LABEL = 'Purchases Panel Race Suite Tester';
const PRODUCT_NAME = 'Dangling Race Product';

// --- Seed a real dangling-seller purchase ---
const { browser: seedBrowser, page: seedPage, errors: seedErrors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(seedPage, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(seedPage);

await chooseIdentity(seedPage, { mode: 'sell', label: LABEL, isNew: true });
await seedPage.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await seedPage.waitForTimeout(300);
await seedPage.click('#upload-model-btn');
await seedPage.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await seedPage.fill('#upload-name', PRODUCT_NAME);
await seedPage.fill('#upload-price', '25');
await seedPage.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await seedPage.click('#upload-submit-btn');
await seedPage.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await seedPage.waitForTimeout(300);
await seedPage.click('#upload-submit-btn');
await seedPage.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await seedPage.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return seedPage.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded, priced product found in catalog:', !!template);

const { builder } = (await fetchJson('/api/builders/me')).body;
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = `dangling-race-instance-${Date.now()}`;
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyerLabel: 'A Dangling-Race Shopper', simulatePaidPurchaseForTests: true }),
});
console.log('purchase created (status should be 201):', purchased.status);
console.log('purchase has a paymentIntentId (should be true):', !!purchased.body.purchase?.paymentIntentId);
const purchaseId = purchased.body.purchase?.purchaseId;

execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'higglehaven-db', '--local', '--command',
  `UPDATE purchases SET paid_out_at = '2024-01-01T00:00:00.000Z', stripe_payout_id = 'po_dangling_race_test' WHERE purchase_id = '${purchaseId}'`,
], { cwd: REPO_ROOT, stdio: 'pipe' });
console.log('stood in for a real Stripe payout on the purchase, satisfying the #732/#745 deletion guard');

const { seller } = (await fetchJson('/api/sellers/me')).body;
const deleteResult = await fetchJson(`/api/sellers/${encodeURIComponent(seller.sellerId)}`, { method: 'DELETE' });
console.log('seller self-delete status (should be 200, making seller_id dangling):', deleteResult.status);

await seedBrowser.close();

// --- The actual regression: admin dashboard's Purchases panel race ---
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Delay only the *response* to the 2nd GET for this panel (the manual
// Refresh click below) -- the 1st (the panel's own auto-load on page load)
// and 3rd (fired by the Mark Shipped action's own success path) both pass
// straight through immediately. Critically, this fetches the real response
// right away (so it reflects pre-ship data, same as a real slow-network
// reply the server already answered) and only delays *handing it back* to
// the page -- delaying before route.continue() instead would delay sending
// the request itself, so by the time it reached the server the mark-shipped
// POST would have already landed and the "stale" response would come back
// already fresh, never actually exercising the race at all. The single '*'
// here can't cross a '/', so this never matches the POST to
// /api/purchases/<id>/mark-shipped.
let getCount = 0;
await page.route('**/api/purchases*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getCount += 1;
  const response = await route.fetch();
  if (getCount === 2) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await route.fulfill({ response });
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="purchases"]');

// The panel's own script fires its first load() as soon as it's parsed
// (not lazily on tab-open), so by now request #1 has already resolved --
// wait for the seeded purchase's row to actually be there before racing it.
await page.waitForFunction(
  (id) => document.querySelector(`tr[data-purchase-id="${id}"]`) != null,
  purchaseId,
  { timeout: 10000 },
);

// Column 7 (0-indexed: When, Purchase id, Template, Seller, Buyer, Total,
// Status, Actions) -- the Status cell specifically. The row's full
// textContent is no good for this check: the Actions cell's own "Mark
// Shipped" button label always contains the substring "Shipped" whether or
// not the button is actually enabled, so checking the whole row would
// "pass" even on a reverted/stale row.
const row = () => page.locator(`tr[data-purchase-id="${purchaseId}"]`);
const statusCell = () => row().locator('td').nth(6);
const shipBtnCountBefore = await row().locator('.action-ship').count();
console.log('Mark Shipped button present before any action (should be 1):', shipBtnCountBefore);

await page.click('#purchasesRefreshBtn'); // request #2 -- delayed 2s
await page.waitForTimeout(200);
await row().locator('.action-ship').click(); // POST mark-shipped, then its own request #3 (undelayed)

await page.waitForFunction(
  (id) => {
    const r = document.querySelector(`tr[data-purchase-id="${id}"]`);
    const cell = r && r.querySelectorAll('td')[6];
    return !!cell && cell.textContent.includes('Shipped');
  },
  purchaseId,
  { timeout: 10000 },
);
const statusTextAfterShip = await statusCell().textContent();
console.log('status cell right after marking shipped (should mention "Shipped"):', statusTextAfterShip);

// Wait out the delayed Refresh response too, and confirm it didn't land
// late and revert the status cell back to its pre-ship ("-") state.
await page.waitForTimeout(2200);
const statusTextFinal = await statusCell().textContent();
console.log('status cell after the stale, delayed Refresh response also lands (should still mention "Shipped"):', statusTextFinal);

const pass = !!template && purchased.status === 201 &&
  !!purchased.body.purchase?.paymentIntentId &&
  deleteResult.status === 200 &&
  shipBtnCountBefore === 1 &&
  statusTextAfterShip.includes('Shipped') &&
  statusTextFinal.includes('Shipped') &&
  seedErrors.length === 0 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1928: a stale, delayed Refresh response does not revert a fresher Mark-Shipped row',
  errors,
});
