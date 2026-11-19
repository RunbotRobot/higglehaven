// Regression test for #744: DELETE /api/sellers/:sellerId (worker/index.js,
// added by #732) was a complete, guarded backend endpoint with zero
// frontend way to reach it -- src/api.js had no deleteSeller export, and
// renderSellerIdentityField never wired deleteProfile/deleteWarning/
// onDeleted into the shared renderIdentityField helper the way
// renderBuilderIdentityField already did, so the Sell settings tab showed
// Rename but never a Delete account button at all.
//
// Covers the happy path per the issue's own suggested test scope: clicking
// Delete account in the Storefront leaf actually calls the real endpoint,
// shows a success message, and the account has a fresh, different seller
// identity behind it afterward (the endpoint's own 409-blocked-by-unpaid-
// proceeds case is already covered server-side by worker/commerce.test.js's
// "Seller deletion (#732)" suite).
import {
  launchPage, chooseIdentity, openStorefrontLeaf, waitForText, finish, acceptConfirmModal } from './helpers.mjs';

const LABEL = 'Delete Seller Suite Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });

// #3704: the shop name and Reset Profile are the bud's Storefront leaf (Settings has no Sell tab).
await openStorefrontLeaf(page);
await page.waitForSelector('#bud-leaf-storefront button:has-text("Reset Profile")', { timeout: 15000 });

const originalSellerId = await page.evaluate(() =>
  fetch('/api/sellers/me').then((r) => r.json()).then((d) => d.seller.sellerId));
console.log('sellerId before delete:', originalSellerId);

// #1149 renamed this button from "Delete account" (never true -- it only
// ever reset this profile, not the login) to "Reset Profile"; the
// underlying deleteSeller behavior this test exercises is unchanged.
const deleteBtnVisible = await page.locator('#bud-leaf-storefront button:has-text("Reset Profile")').isVisible();
console.log('Reset Profile button present in the Storefront leaf (should be true -- this is the bug #744 fixes):', deleteBtnVisible);

// --- Reset Profile (launchPage's own dialog handler auto-accepts confirm()) ---
await page.click('#bud-leaf-storefront button:has-text("Reset Profile")');
await acceptConfirmModal(page); // #3278: in-app confirm modal
const deleteStatus = await waitForText(page, '#bud-leaf-storefront', 'Reset', { timeout: 8000 });
console.log('Settings section text right after delete (should mention "Reset"):', deleteStatus);

// Ground truth: whichever seller the session now really maps to, read
// directly from the server -- this is exactly what deleteSeller's own
// auto-provisioned replacement seller looks like.
const freshSellerId = await page.evaluate(() =>
  fetch('/api/sellers/me').then((r) => r.json()).then((d) => d.seller.sellerId));
console.log('Fresh sellerId the server now associates with this session:', freshSellerId);

const pass = deleteBtnVisible &&
  deleteStatus.includes('Reset') &&
  Boolean(freshSellerId) && freshSellerId !== originalSellerId &&
  errors.length === 0;
await finish(browser, { pass, label: 'Deleting a seller account works end-to-end from the Storefront leaf (#744)', errors });
