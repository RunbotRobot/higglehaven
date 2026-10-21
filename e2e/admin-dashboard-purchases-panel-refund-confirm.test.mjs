// #2081: the Admin Dashboard's Purchases (dangling-seller) panel fired a
// real, unconditional Stripe refund the instant the Refund button was
// clicked, with no confirm() step -- the one dangerous action in this whole
// dashboard without one (every other irreversible admin action here --
// revoke-admin, delete-land-candidate, tax-form approve/file/void, R2 model
// delete, auction-cancel-and-reassign -- already confirms first). This
// verifies both halves of the fix: dismissing the confirm leaves the
// purchase untouched, and accepting it still actually refunds.
//
// Seeding recipe adapted from e2e/admin-dashboard-purchases-panel-race.test.mjs's
// own comment, with one deliberate difference: that recipe uses
// simulatePaidPurchaseForTests to mint a real paymentIntentId, which it
// needs purely to satisfy the seller-delete guard (#732/#745 -- blocks
// deleting a seller with an unpaid real-money purchase). This test instead
// omits simulatePaidPurchaseForTests entirely: with no paymentIntentId, that
// guard's own WHERE clause (payment_intent_id IS NOT NULL) never matches, so
// the seller can self-delete immediately with no D1 workaround needed at
// all, and GET /api/purchases?danglingSeller=1 -- the query the admin
// dashboard's panel and this test both read from -- has no paymentIntentId
// requirement of its own either (worker/index.js's own handler for it).
//
// This isn't just a simplification: a paymentIntentId-bearing purchase
// cannot actually be refunded in this suite at all.
// handlePurchaseRefund->finalizeRefundReversal only skips its real Stripe
// call when `purchase.payment_intent_id` is falsy; once it's set (which
// simulatePaidPurchaseForTests exists specifically to do), the function
// requires stripeConfigured(env) and this suite never sets
// STRIPE_SECRET_KEY (same reason the race-test sibling's own comment gives
// for why it can't drive a real Stripe checkout either) -- so the refund
// endpoint would 503 ("Stripe payments are not configured on this server
// yet.") every single time. That's exactly what three earlier revisions of
// this test chased: CI's own .dev.vars (unlike a bare local checkout) sets
// E2E_SIMULATE_PAID_PURCHASES=true, so only there did
// simulatePaidPurchaseForTests actually mint a non-null paymentIntentId and
// hit this 503 -- locally, with that var unset, the purchase's
// paymentIntentId stayed null and the real refund trivially succeeded,
// masking the bug in every local run. Reproduced directly by copying CI's
// own .dev.vars locally once (E2E_SIMULATE_PAID_PURCHASES=true) and
// confirming the identical 503 appeared. The two wrangler-d1-execute calls,
// and the write-visibility poll added to wait on the second one, existed
// only to support a paymentIntentId this test never actually needed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish, emailForLabel, grantAdmin,
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

// #653: the simulated path is now admin-only (this seller hasn't
// completed Stripe Connect onboarding) — grant it to this same seeding
// account rather than switching to a separate one, so this purchase
// still lands against the product/landlet it already built up under
// this session's own cookie.
await grantAdmin(emailForLabel(LABEL));

// No simulatePaidPurchaseForTests -- see this file's own top comment for
// why that's deliberate, not an oversight: leaving paymentIntentId null is
// what makes a real refund possible here at all, and is also what lets the
// seller below self-delete immediately with no D1 workaround.
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyerLabel: 'A Dangling-Refund-Confirm Shopper' }),
});
console.log('purchase created (status should be 201):', purchased.status);
const purchaseId = purchased.body.purchase?.purchaseId;

const { seller } = (await fetchJson('/api/sellers/me')).body;
const deleteResult = await fetchJson(`/api/sellers/${encodeURIComponent(seller.sellerId)}`, { method: 'DELETE' });
console.log('seller self-delete status (should be 200, making seller_id dangling):', deleteResult.status);

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
