// Regression test for #1596: owner report that clicking Shop/Build in
// #mode-nav while the Seller ("My Products") modal is open does nothing —
// the user had to close the modal first, unlike every other mode switch in
// the app. Root cause: #mode-nav sat at the old z-index:10, same tier as
// every other floating-HUD element, while the Seller modal's own
// full-viewport backdrop sits at z-index:20 above it — the exact same shape
// as #539 (see menu-access-from-sell.test.mjs), just for #mode-nav instead
// of #topbar-left. Fixed by raising #mode-nav to z-index:21, matching
// #topbar-left (see its own CSS comment for the shared reasoning). This test
// proves the Build button is not just visually on top but actually
// clickable while Sell is open, since Playwright's own actionability checks
// fail a click on an element another one is covering.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Mode Nav From Sell Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

// The real proof: clicking Build while Sell's modal is open actually lands
// (pre-fix, the click would silently hit the Seller modal's own backdrop
// instead, and #mode-nav's click handler's own `location.reload()` would
// never fire).
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

// A real reload happened and landed in Build — not just a same-document
// click that did nothing, which would leave Sell still active and the
// Seller modal still open.
const buildNavActiveAfter = await page.locator('.mode-nav-btn[data-mode="build"]').evaluate((el) => el.classList.contains('active'));
const buildNavAriaPressedAfter = await page.locator('.mode-nav-btn[data-mode="build"]').getAttribute('aria-pressed');
const sellerModalGoneAfter = await page.locator('#seller-modal.visible').count();
console.log('Build nav active after clicking it over the open Seller modal (should be true):', buildNavActiveAfter);
console.log('Build nav aria-pressed after the switch (should be "true"):', buildNavAriaPressedAfter);
console.log('Seller modal no longer open after switching to Build (should be 0):', sellerModalGoneAfter);

const pass = buildNavActiveAfter === true && buildNavAriaPressedAfter === 'true' && sellerModalGoneAfter === 0 &&
  errors.length === 0;
await finish(browser, { pass, label: '#1596: Shop/Build in #mode-nav stay clickable while the Seller modal is open', errors });
