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
import { launchPage, finish, waitForText } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Settings Identity Suite' });
const email = `settings-identity-shop-${Date.now()}@example.com`;

// --- Sign up entirely from Shop mode, never touching the Build/Sell nav ---
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.click('#account-auth-btn');
await page.waitForSelector('#auth-modal.visible', { timeout: 5000 });
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Settings Identity Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', 'a fine long password');
await page.click('#auth-signup-form button[type="submit"]');
const btnLabelAfterSignup = await waitForText(page, '#account-auth-btn', 'Settings Identity Suite');
console.log('account button after signup, still in Shop mode (should be "Settings Identity Suite"):', btnLabelAfterSignup);
await page.click('#auth-close-btn');
await page.waitForTimeout(200);

// --- Open Settings > Build without ever switching mode-nav to Build ---
await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');

// Land Cap: previously omitted entirely (renderLandCapField returned before
// appending anything) whenever builderId was still null.
const landCapText = await waitForText(page, '#settings-section .settings-field', 'You own');
console.log('Land Cap field text for a fresh, already-logged-in visitor (should mention "You own 0m²" of a 1000m² starter cap):', landCapText);

// Auction section: previously stuck on the dead-end identity message even
// though this visitor is logged in — should now reach the real
// "claim a landlet first" copy instead.
const auctionSectionText = await waitForText(page, '#settings-section', 'Claim a landlet first to auction it off.');
const stillShowsIdentityPrompt = auctionSectionText.includes('Choose a builder identity');
console.log('Settings > Build section text (should mention "Claim a landlet first", must NOT still say "Choose a builder identity"):', auctionSectionText);

const pass = landCapText.includes('You own 0m²') && landCapText.includes('1000m² cap') &&
  auctionSectionText.includes('Claim a landlet first to auction it off.') &&
  !stillShowsIdentityPrompt &&
  errors.length === 0;
await finish(browser, { pass, label: 'Settings > Build tab establishes builder identity for an already-logged-in Shop-mode visitor', errors });
