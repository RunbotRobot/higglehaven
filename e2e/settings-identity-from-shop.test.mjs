// Regression test: opening the global Settings modal's Build tab from Shop
// mode (reachable via #settings-btn in the account menu regardless of
// currentMode) used to show "Choose a builder identity to start or bid on
// an auction" — and silently omit the Land Cap field entirely — for an
// already-logged-in visitor, purely because builderId (a separate,
// Build-mode-specific identity cache) is normally only ever populated by
// ensureBuilderIdentity(), which nothing calls unless the visitor actually
// enters Build mode or takes a Build/Sell action first. Logging in via the
// account menu's own #account-auth-btn (the same real-UI flow
// e2e/auth.test.mjs uses) never touches builderId at all. Fixed by having
// renderLandCapField/renderAuctionSection silently establish builderId
// themselves when a session already exists (requireLogin's own
// `if (currentAuthUser) return currentAuthUser` guarantees this never pops
// a login prompt) instead of leaving the visitor looking logged out.
import {
  launchPage, finish, waitForText, clearVerifyModalIfShown,
} from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Settings Identity Suite' });
const email = `settings-identity-shop-${Date.now()}@example.com`;

// --- Sign up entirely from Shop mode, never touching the Build/Sell nav ---
// N44 (owner, 2026-09-12): Shop mode's own entry now requires this same
// login + verification gate Build/Sell already had (ensureShopperIdentity,
// src/main.js), so #auth-modal is already open by the time this page
// finishes loading — no need to reach it via the account menu's own
// #account-auth-btn anymore, that path is simply not exercised on a fresh
// visit now. The regression this test protects against (renderLandCapField/
// renderAuctionSection leaving builderId unset for an already-logged-in
// visitor who never took a Build/Sell action) is unchanged either way.
await page.waitForSelector('#auth-modal.visible', { timeout: 8000 });
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Settings Identity Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', 'a fine long password');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 10000 });
// Shop mode's own gate (ensureShopperIdentity) requires clearing the same
// #556 age/card verification step Build/Sell already did — completing it
// here is what actually lets enterShopMode finish loading the world below,
// same as chooseIdentity's own post-signup step in helpers.mjs.
await clearVerifyModalIfShown(page);
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
const btnLabelAfterSignup = await waitForText(page, '#account-auth-btn', 'Settings Identity Suite');
console.log('account button after signup, in Shop mode (should be "Settings Identity Suite"):', btnLabelAfterSignup);

// --- Open Settings > Build without ever switching mode-nav to Build ---
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');

// #556: renderLandCapField's own silent ensureBuilderIdentity() call above
// also runs into the age-attestation/credit-card gate (requireLogin's
// "never pops a login prompt" guarantee doesn't extend to this separate
// gate) — this account already cleared it during Shop mode's own entry
// above (N44), so requireVerification's own early-return means this is a
// harmless no-op now rather than the thing actually unblocking the Land
// Cap field below; kept as a defensive no-op in case that ordering ever
// changes back.
await clearVerifyModalIfShown(page);

// Land Cap: previously omitted entirely (renderLandCapField returned before
// appending anything) whenever builderId was still null.
const landCapText = await waitForText(page, '#settings-section .settings-field', 'You own');
console.log('Land Cap field text for a fresh, already-logged-in visitor (should mention "You own 0m²" of a 1,000m² starter cap):', landCapText);

// Auction section: previously stuck on the dead-end identity message even
// though this visitor is logged in — should now reach the real
// "claim a landlet first" copy instead.
const auctionSectionText = await waitForText(page, '#settings-section', 'Claim a landlet first to auction it off.');
const stillShowsIdentityPrompt = auctionSectionText.includes('Choose a builder identity');
console.log('Settings > Build section text (should mention "Claim a landlet first", must NOT still say "Choose a builder identity"):', auctionSectionText);

// formatArea comma-groups thousands by default (owner feedback) — see
// land-cap.test.mjs's own comment on this — so a 1000m² cap reads "1,000m²".
const pass = landCapText.includes('You own 0m²') && landCapText.includes('1,000m² cap') &&
  auctionSectionText.includes('Claim a landlet first to auction it off.') &&
  !stillShowsIdentityPrompt &&
  errors.length === 0;
await finish(browser, { pass, label: 'Settings > Build tab establishes builder identity for an already-logged-in Shop-mode visitor', errors });
