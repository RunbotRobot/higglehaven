// Regression test for #905: renderLandCapField/renderRedeemHigglesField/
// renderAuctionSection each await ensureBuilderIdentity() (a real network
// round trip whenever Settings was opened from Shop mode before Build mode
// ever established builderId) before appending their own content to
// #settings-section — but switching tabs is synchronous and unconditional,
// so a since-superseded call's financially-relevant controls (Redeem
// Higgles, Start Auction) used to land on whatever tab was showing by the
// time the await resolved. Same "delay one endpoint, act during the gap"
// technique as seller-modal-reopen-race.test.mjs.
import { launchPage, chooseIdentity, openAccountMenu, waitForText, finish } from './helpers.mjs';

const LABEL = 'Settings Tab Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Stays in Shop mode only — Build mode is never entered, so builderId is
// still null going into Settings, the exact precondition #905's own
// comment documents (renderLandCapField's "Settings opened from Shop mode
// before Build mode ever ran ensureBuilderIdentity()").
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });

await openAccountMenu(page);
await page.click('#settings-btn');
// Widened from 10000/300ms -- this file was the companion failure in a
// CI-only re-run of #2194 (settings-stale-after-delete.test.mjs failing
// alongside a *different* file than its own first failure) despite a
// clean 2/2 local pass on the exact same commit, matching this fleet's
// established #978-class runner-load-margin pattern rather than a real
// bug.
await page.waitForSelector('#settings-modal.visible', { timeout: 15000 });
await page.waitForTimeout(500);

// Delay only GET /api/builders/me — the network call ensureBuilderIdentity()
// makes for an already-logged-in visitor — long enough to reliably switch
// tabs before it resolves.
await page.route('**/api/builders/me', async (route) => {
  if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.continue();
});

await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForTimeout(400);
await page.click('.settings-tab-btn[data-section="general"]');
await page.waitForTimeout(400);
const generalTabHtmlRightAfterSwitch = await page.locator('#settings-section').innerHTML();
console.log('General tab content right after switching away (should not yet mention Land Cap/Redeem Higgles/Auction):',
  /Land Cap|Redeem Higgles|Active Auctions/.test(generalTabHtmlRightAfterSwitch) ? 'MENTIONS THEM' : 'clean');

// Wait past the delayed GET's own delay so the three superseded calls
// actually resolve and (pre-fix) would have appended onto this tab.
// Widened from 2500ms for more margin past the 2000ms route delay above
// under CI load (see the modal-wait comment above for why).
await page.waitForTimeout(4000);

const stillOnGeneralTab = await page.locator('.settings-tab-btn[data-section="general"]').evaluate((el) => el.classList.contains('active'));
console.log('still showing the General tab (should be true — no tab-switch happened on our own):', stillOnGeneralTab);

const generalTabHtmlAfterDelay = await page.locator('#settings-section').innerHTML();
const leaked = /Land Cap|Redeem Higgles|Active Auctions|Sell Your/.test(generalTabHtmlAfterDelay);
console.log('General tab content after the delayed identity-fetch resolves (should still be clean, not leaked):', leaked ? 'LEAKED' : 'clean');

await page.unroute('**/api/builders/me');

// Switching back to Build afterward should still work normally — the fix
// only skips a superseded render, not a fresh, current one.
//
// #2135/#2136/#2570 each widened this wait's margin again (10000ms ->
// dishonored-as-30000ms -> honored 10000ms -> 60000ms -> 120000ms) as a
// single polling waitForFunction(textContent.includes('Land Cap')) budget,
// and #2631 timed out again anyway at 120000ms. That one combined budget
// was covering two different things at once: the real GET /api/builders/me
// round trip (the actual CI-load-variable part #1388-class flakes are
// about) *and* the DOM update after it resolves (synchronous, effectively
// instant once the response is in hand) — so every bump widened a budget
// most of which was never the actual bottleneck. Splitting them, same
// waitForResponse-paired-with-the-triggering-click shape as e2e/auth.test.mjs's
// firstSellerFetch/secondSellerFetch: the network wait gets the generous,
// CI-load-tolerant margin (set up before the click so there's no risk of
// missing a response that lands fast); the render-confirmation wait stays
// short, since a real regression in the render path should fail fast and
// distinctly rather than hiding inside one more escalation of the same
// combined timeout.
const builderMeFetchLanded = page.waitForResponse(
  (r) => r.url().includes('/api/builders/me') && r.request().method() === 'GET',
  { timeout: 120000 },
);
await page.click('.settings-tab-btn[data-section="build"]');
await builderMeFetchLanded;
const buildTabWorksNormally = (await waitForText(page, '#settings-section', 'Land Cap')).includes('Land Cap');
console.log('Build tab still renders Land Cap normally on a fresh, non-superseded switch (should be true):', buildTabWorksNormally);

const pass = !/Land Cap|Redeem Higgles|Active Auctions/.test(generalTabHtmlRightAfterSwitch) &&
  stillOnGeneralTab &&
  !leaked &&
  buildTabWorksNormally &&
  errors.length === 0;
await finish(browser, { pass, label: '#905: a Settings tab switch mid-load does not leak the superseded tab\'s controls', errors });
