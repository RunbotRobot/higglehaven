// #2081: the Admin Dashboard's Purchases (dangling-seller) panel fired a
// real, unconditional Stripe refund the instant the Refund button was
// clicked, with no confirm() step -- the one dangerous action in this whole
// dashboard without one (every other irreversible admin action here --
// revoke-admin, delete-land-candidate, tax-form approve/file/void, R2 model
// delete, auction-cancel-and-reassign -- already confirms first). This
// verifies both halves of the fix: dismissing the confirm leaves the
// purchase untouched, and accepting it still actually refunds.
//
// Seeding recipe reused verbatim from
// e2e/admin-dashboard-purchases-panel-race.test.mjs's own comment: a real
// dangling-seller purchase needs a builder to claim land and place a
// seller's priced product, buy it (simulatePaidPurchaseForTests for a real
// paymentIntentId), stand in for a real Stripe payout via a direct D1 write
// (this suite never configures STRIPE_SECRET_KEY, so there's no real way
// through the app's own HTTP surface to satisfy the #732/#745 deletion
// guard), then have the seller self-delete so the purchase's seller_id goes
// dangling.
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

const LABEL = 'Refund Confirm Suite Tester';
const PRODUCT_NAME = 'Dangling Refund Confirm Product';

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

const instanceId = `dangling-refund-confirm-instance-${Date.now()}`;
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyerLabel: 'A Dangling-Refund-Confirm Shopper', simulatePaidPurchaseForTests: true }),
});
console.log('purchase created (status should be 201):', purchased.status);
const purchaseId = purchased.body.purchase?.purchaseId;

execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'higglehaven-db', '--local', '--command',
  `UPDATE purchases SET paid_out_at = '2024-01-01T00:00:00.000Z', stripe_payout_id = 'po_dangling_refund_confirm_test' WHERE purchase_id = '${purchaseId}'`,
], { cwd: REPO_ROOT, stdio: 'pipe' });

const { seller } = (await fetchJson('/api/sellers/me')).body;
const deleteResult = await fetchJson(`/api/sellers/${encodeURIComponent(seller.sellerId)}`, { method: 'DELETE' });
console.log('seller self-delete status (should be 200, making seller_id dangling):', deleteResult.status);

// The seller is gone now, so nothing re-checks paid_out_at/stripe_payout_id
// for the deletion guard's sake anymore -- clear them back to null so
// handlePurchaseRefund's own separate "already paid out, can't auto-refund"
// 409 guard (worker/index.js's own #(see that handler)) doesn't fire when
// this test actually exercises a real refund below.
execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'higglehaven-db', '--local', '--command',
  `UPDATE purchases SET paid_out_at = NULL, stripe_payout_id = NULL WHERE purchase_id = '${purchaseId}'`,
], { cwd: REPO_ROOT, stdio: 'pipe' });

await seedBrowser.close();

// --- The actual regression: Refund requires confirmation ---
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });

// The second `wrangler d1 execute` above (clearing paid_out_at back to NULL)
// runs as a separate process against the same local D1 SQLite file while
// wrangler dev is already up and serving requests -- unlike everything else
// in this shard, this test (and its sibling
// admin-dashboard-purchases-panel-race.test.mjs, which does the same thing
// for its own, single, paid_out_at-setting write) is the only file making an
// external write to the live D1 file mid-run rather than through the app's
// own HTTP surface. That's exactly the kind of cross-process write that can
// take a beat longer to become visible to the already-running server under
// real CI load than it does locally -- rather than guessing at a fixed delay
// (already tried once and still saw this test fail in CI), poll the actual
// endpoint handlePurchaseRefund itself re-reads from (GET
// /api/purchases?danglingSeller=1) until it reflects the cleared value, so
// the refund click below never races the write.
// 30000ms, not the original 10000ms: this exact poll already fired its own
// distinguishing "never read back as cleared" error on the CI run right
// after it was added (admin-dashboard-purchases-panel-refund-confirm.test.mjs
// was still the only failure, console output unreachable per usual, but the
// shape -- isolated, repeated failure of this file alone -- is consistent
// with the write-visibility lag this poll targets simply being longer than
// 10s under this shard's real CI load). 30s matches this file's own other
// margins (the two .action-refund click timeouts below) and this suite's
// established precedent for heavy-seeding-chain + admin-dashboard CI load
// (#978/#1224/#1469/#1511).
async function waitForPaidOutAtCleared(timeoutMs = 30000, intervalMs = 300) {
  const start = Date.now();
  for (;;) {
    const res = await page.evaluate(async (id) => {
      const r = await fetch('/api/purchases?danglingSeller=1&limit=100');
      const body = await r.json();
      const found = (body.purchases || []).find((p) => p.purchaseId === id);
      return found ? found.paidOutAt : 'not-found';
    }, purchaseId);
    if (res === null) {
      console.log(`paidOutAt read back as cleared after ${Date.now() - start}ms`);
      return;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`purchase ${purchaseId}'s paidOutAt never read back as cleared via GET /api/purchases?danglingSeller=1 within ${timeoutMs}ms (last seen: ${JSON.stringify(res)}) -- the external wrangler d1 execute reset may not have become visible to the running server in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
await waitForPaidOutAtCleared();
await page.click('button[data-panel="purchases"]');

await page.waitForFunction(
  (id) => document.querySelector(`tr[data-purchase-id="${id}"]`) != null,
  purchaseId,
  { timeout: 20000 },
);

const row = () => page.locator(`tr[data-purchase-id="${purchaseId}"]`);
const statusCell = () => row().locator('td').nth(6);

// First click: dismiss the confirm, the same as a real user clicking
// Cancel -- the refund must not fire at all. (Registering any 'dialog'
// listener takes over resolving it from Playwright's own auto-dismiss
// default, so this handler must call dismiss() itself or the dialog --
// and the page's JS, since window.confirm() is synchronous -- hangs.)
let dialogMessageSeen = null;
page.once('dialog', (dialog) => { dialogMessageSeen = dialog.message(); dialog.dismiss(); });
await row().locator('.action-refund').click({ timeout: 30000 });
await page.waitForTimeout(1000);
console.log('confirm() dialog message on dismissed click (should mention "Refund" and this purchase id):', dialogMessageSeen);
const statusTextAfterDismiss = await statusCell().textContent();
console.log('status cell after dismissing the confirm (should still be the pre-refund dash):', JSON.stringify(statusTextAfterDismiss));

// Second click: accept the confirm -- the refund should actually go through.
// 30s/20s margins (vs. a plain 10s) match this suite's own established
// precedent for this exact heavy-seeding-chain + admin-dashboard shape
// (e.g. #978/#1224/#1469/#1511's land.test.js timeout bumps) -- this test's
// own seed chain already does a real model upload, catalog create, instance
// create, purchase, two separate `wrangler d1 execute` process spawns, and
// a seller delete before ever reaching the dashboard, all of which get
// slower, not just this click's own real backend refund round-trip, under
// the shared-runner CI load this repo's CI visibly runs under.
page.once('dialog', (dialog) => dialog.accept());
await row().locator('.action-refund').click({ timeout: 30000 });
await page.waitForFunction(
  (id) => {
    const r = document.querySelector(`tr[data-purchase-id="${id}"]`);
    const cell = r && r.querySelectorAll('td')[6];
    return !!cell && cell.textContent.includes('Refunded');
  },
  purchaseId,
  { timeout: 20000 },
);
const statusTextAfterAccept = await statusCell().textContent();
console.log('status cell after accepting the confirm (should mention "Refunded"):', statusTextAfterAccept);

const pass = !!template && purchased.status === 201 &&
  deleteResult.status === 200 &&
  dialogMessageSeen != null && dialogMessageSeen.includes('Refund') && dialogMessageSeen.includes(purchaseId) &&
  statusTextAfterDismiss.trim() === '—' &&
  statusTextAfterAccept.includes('Refunded') &&
  seedErrors.length === 0 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2081: Admin Purchases panel Refund requires confirmation',
  errors,
});
