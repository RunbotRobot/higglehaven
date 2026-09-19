// Regression test for #744: DELETE /api/sellers/:sellerId (worker/index.js,
// added by #732) was a complete, guarded backend endpoint with zero
// frontend way to reach it -- src/api.js had no deleteSeller export, and
// renderSellerIdentityField never wired deleteProfile/deleteWarning/
// onDeleted into the shared renderIdentityField helper the way
// renderBuilderIdentityField already did, so the Sell settings tab showed
// Rename but never a Delete Account button at all.
//
// Covers the happy path per the issue's own suggested test scope: clicking
// Delete Account in Settings > Sell actually calls the real endpoint,
// shows a success message, and the account has a fresh, different seller
// identity behind it afterward (the endpoint's own 409-blocked-by-unpaid-
// proceeds case is already covered server-side by worker/commerce.test.js's
// "Seller deletion (#732)" suite).
import {
  launchPage, chooseIdentity, openAccountMenu, waitForText, finish,
} from './helpers.mjs';

const LABEL = 'Delete Seller Suite Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });

// Settings opens directly into the Sell tab (openSettingsModal derives
// activeSettingsTab from currentMode, still 'sell' here) -- the Seller
// modal stays open underneath, same as menu-access-from-sell.test.mjs's
// own proof that Settings is reachable on top of it.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });

const originalSellerId = await page.evaluate(() =>
  fetch('/api/sellers/me').then((r) => r.json()).then((d) => d.seller.sellerId));
console.log('sellerId before delete:', originalSellerId);

const deleteBtnVisible = await page.locator('#settings-section button:has-text("Delete Account")').isVisible();
console.log('Delete Account button present in Settings > Sell (should be true -- this is the bug #744 fixes):', deleteBtnVisible);

// --- Delete Account (launchPage's own dialog handler auto-accepts confirm()) ---
await page.click('#settings-section button:has-text("Delete Account")');
const deleteStatus = await waitForText(page, '#settings-section', 'Deleted', { timeout: 8000 });
console.log('Settings section text right after delete (should mention "Deleted"):', deleteStatus);

// Ground truth: whichever seller the session now really maps to, read
// directly from the server -- this is exactly what deleteSeller's own
// auto-provisioned replacement seller looks like.
const freshSellerId = await page.evaluate(() =>
  fetch('/api/sellers/me').then((r) => r.json()).then((d) => d.seller.sellerId));
console.log('Fresh sellerId the server now associates with this session:', freshSellerId);

const pass = deleteBtnVisible &&
  deleteStatus.includes('Deleted') &&
  Boolean(freshSellerId) && freshSellerId !== originalSellerId &&
  errors.length === 0;
await finish(browser, { pass, label: 'Deleting a seller account works end-to-end from Settings > Sell (#744)', errors });
