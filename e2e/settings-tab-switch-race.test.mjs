// Regression test for #905: renderLandCapField/renderRedeemHigglesField/
// renderAuctionSection each await ensureBuilderIdentity() (a real network
// round trip whenever Settings was opened from Shop mode before Build mode
// ever established builderId) before appending their own content to
// #settings-section — but switching tabs is synchronous and unconditional,
// so a since-superseded call's financially-relevant controls (Redeem
// Higgles, Start Auction) used to land on whatever tab was showing by the
// time the await resolved. Same "delay one endpoint, act during the gap"
// technique as seller-modal-reopen-race.test.mjs.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

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
await page.click('.settings-tab-btn[data-section="build"]');
// #2135: waitForFunction's signature is (pageFunction, arg, options) -- the
// 2-argument call this used to be (fn, { timeout: 10000 })) put the options
// object in the `arg` slot instead, so `options` stayed undefined and the
// *real* applied timeout was always Playwright's actual default (30000ms),
// not the 10000ms written here -- confirmed directly against the CI
// failure this issue was filed from ("Timeout 30000ms exceeded" at this
// exact line). That default still wasn't enough margin under CI load, so
// fixing the arg/options mix-up alone would make it worse (an *honored*
// 10000ms is less generous than the *dishonored* 30000ms it was actually
// getting) -- the explicit `null` arg reaches the options slot, and the
// timeout itself is widened well past the old effective default for real
// headroom, same as this suite's own account-menu-modal wait (60000ms,
// e2e/helpers.mjs) for a comparable post-signup/identity-flow margin.
// #2570: 60000ms stopped being enough under further CI-load growth (timed
// out again on an entirely unrelated PR) -- widened again, same mitigation
// shape as #2135/#2136's own margin bumps for this fleet's well-established
// #978-class runner-load-margin flakes. The job itself has no step/job-level
// timeout (`.github/workflows/ci.yml` sets none, so GitHub's 6-hour default
// applies), so there's ample headroom to widen this well past what any
// observed failure has actually needed.
await page.waitForFunction(
  () => document.getElementById('settings-section').textContent.includes('Land Cap'),
  null,
  { timeout: 120000 },
);
const buildTabWorksNormally = (await page.textContent('#settings-section')).includes('Land Cap');
console.log('Build tab still renders Land Cap normally on a fresh, non-superseded switch (should be true):', buildTabWorksNormally);

const pass = !/Land Cap|Redeem Higgles|Active Auctions/.test(generalTabHtmlRightAfterSwitch) &&
  stillOnGeneralTab &&
  !leaked &&
  buildTabWorksNormally &&
  errors.length === 0;
await finish(browser, { pass, label: '#905: a Settings tab switch mid-load does not leak the superseded tab\'s controls', errors });
