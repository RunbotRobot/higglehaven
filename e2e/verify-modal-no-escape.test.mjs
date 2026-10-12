// #1731: #verify-modal (age attestation + credit-card verification, #556)
// has a deliberate "no escape" design — the in-source comment right above
// openVerifyModal/closeVerifyModal in src/main.js explains the only way out
// is logging out via verifyLogoutBtn, since this app has no unverified-but-
// logged-in state a Build/Sell/Shop session can sit in (N44 extended this
// gate to Shop mode too, via ensureShopperIdentity). The shared modal
// accessibility infra's global Escape handler (openModalA11y/closeModalA11y
// in src/main.js) didn't know about that contract and was wiring Escape to
// close this modal like any other, silently bypassing the gate and leaving
// the identity flow wedged in an inconsistent state.
//
// Signed up directly through the auth modal (not via chooseIdentity, which
// auto-clears #verify-modal the instant it appears via its own
// clearVerifyModalIfShown call) so this test can press Escape on it first,
// before anything else clears it. A fresh page load already lands in Shop
// mode and opens #auth-modal for its own gate (same as modal-keyboard-
// accessibility.test.mjs's own `chooseIdentity(page, { mode: 'shop' })`
// call), so no mode-nav click is needed to reach it.
import { launchPage, finish, clearVerifyModalIfShown } from './helpers.mjs';

const LABEL = `Verify Modal Escape ${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.waitForSelector('#auth-modal.visible', { timeout: 8000 });

const email = `verify-escape-${Date.now()}@e2e.test`;
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', LABEL);
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', 'e2e-test-password-123');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 20000 });

await page.waitForSelector('#verify-modal.visible', { timeout: 10000 });

// Gate not cleared yet — enterShopMode's own post-gate work (loading the
// world) hasn't started, so #shop-status never got its 'visible' class.
// This is the same "did the gated flow actually proceed" signal
// auth.test.mjs uses for the Sell-mode equivalent (/api/sellers/me), just
// Shop mode's own version of it.
const shopStatusVisibleBeforeEscape = (await page.locator('#shop-status.visible').count()) === 1;
console.log('Shop world load started before Escape (should be false — still gated):', shopStatusVisibleBeforeEscape);

await page.keyboard.press('Escape');
await page.waitForTimeout(1000);

const stillVisibleAfterEscape = (await page.locator('#verify-modal.visible').count()) === 1;
console.log('Verify modal still visible after Escape (should be true — no escape hatch):', stillVisibleAfterEscape);

const shopStatusVisibleAfterEscape = (await page.locator('#shop-status.visible').count()) === 1;
console.log('Escape alone let the gated shop flow proceed (should be false):', shopStatusVisibleAfterEscape);

// Escape shouldn't have broken the real exit path — the legitimate
// Continue-button close still works afterward.
await clearVerifyModalIfShown(page);
await page.waitForSelector('#shop-status.visible', { timeout: 15000 }).catch(() => {});
const clearedViaContinueButton = (await page.locator('#shop-status.visible').count()) === 1;
console.log('Clearing the gate via the real Continue button still works (should be true):', clearedViaContinueButton);

const pass = !shopStatusVisibleBeforeEscape &&
  stillVisibleAfterEscape &&
  !shopStatusVisibleAfterEscape &&
  clearedViaContinueButton &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Verify (age/card) modal has no Escape hatch — only the real Continue/logout paths clear it (#1731)',
  errors,
});
