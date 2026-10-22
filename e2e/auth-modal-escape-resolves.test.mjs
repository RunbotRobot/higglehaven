// #1730: closeAuthModal (the function openModalA11y registers as
// #auth-modal's own Escape handler) used to only hide the modal -- unlike
// #auth-close-btn's click handler, which also calls notifyAuthResult(null)
// to settle whatever's awaiting waitForAuthResult(). Escape skipping that
// step left the promise permanently unresolved, wedging whatever flow
// opened the modal (here, Shop mode's own ensureShopperIdentity gate,
// N44) forever -- enterShopMode's own `await ensureShopperIdentity()`
// would simply never return, so neither its success path nor its decline
// path (showShopAccessGate) ever ran. This mirrors e2e/identity-and-ui-
// chrome.test.mjs's own "Cancel out entirely" assertions, but via Escape
// instead of clicking #auth-close-btn.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Auth Escape Suite' });

// N44: Shop mode's own entry gates on #auth-modal before this test clicks
// anything -- a fresh page load already shows it.
await page.waitForSelector('#auth-modal.visible', { timeout: 10000 });
await page.keyboard.press('Escape');

await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const modalClosedByEscape = (await page.locator('#auth-modal.visible').count()) === 0;
console.log('auth modal closed by Escape (should be true):', modalClosedByEscape);

// Only reachable once ensureShopperIdentity()'s own await actually
// resolves (with null, since nothing was signed in) and enterShopMode's
// decline branch (showShopAccessGate) runs -- before the fix, this never
// appears at all, and the wait below times out.
// #2639 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeout itself is widened to 60000ms for real headroom under
// CI load.
await page.waitForFunction(
  () => document.getElementById('shop-status')?.textContent === 'Sign in and complete age verification to continue.',
  null,
  { timeout: 60000 },
);
const shopStatusText = await page.textContent('#shop-status');
console.log('Shop access-gate status text after declining via Escape (should be the sign-in prompt):', shopStatusText);

// The flow genuinely completed, not just "looks closed" -- a fresh
// identity-requiring action (Sell nav) reopens the modal and works
// normally, rather than hanging on the same already-exhausted promise.
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#auth-modal.visible', { timeout: 10000 });
const reopenedForSellNav = (await page.locator('#auth-modal.visible').count()) === 1;
console.log('auth modal reopens normally for a later identity-requiring action (should be true):', reopenedForSellNav);

const pass =
  modalClosedByEscape &&
  shopStatusText === 'Sign in and complete age verification to continue.' &&
  reopenedForSellNav &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1730: Escape on the auth modal settles its pending promise, same as the explicit close button',
  errors,
});
