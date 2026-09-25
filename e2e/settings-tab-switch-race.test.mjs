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
await page.waitForSelector('#settings-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

// Delay only GET /api/builders/me — the network call ensureBuilderIdentity()
// makes for an already-logged-in visitor — long enough to reliably switch
// tabs before it resolves.
await page.route('**/api/builders/me', async (route) => {
  if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.continue();
});

await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForTimeout(200);
await page.click('.settings-tab-btn[data-section="general"]');
await page.waitForTimeout(200);
const generalTabHtmlRightAfterSwitch = await page.locator('#settings-section').innerHTML();
console.log('General tab content right after switching away (should not yet mention Land Cap/Redeem Higgles/Auction):',
  /Land Cap|Redeem Higgles|Active Auctions/.test(generalTabHtmlRightAfterSwitch) ? 'MENTIONS THEM' : 'clean');

// Wait past the delayed GET's own delay so the three superseded calls
// actually resolve and (pre-fix) would have appended onto this tab.
await page.waitForTimeout(2500);

const stillOnGeneralTab = await page.locator('.settings-tab-btn[data-section="general"]').evaluate((el) => el.classList.contains('active'));
console.log('still showing the General tab (should be true — no tab-switch happened on our own):', stillOnGeneralTab);

const generalTabHtmlAfterDelay = await page.locator('#settings-section').innerHTML();
const leaked = /Land Cap|Redeem Higgles|Active Auctions|Sell Your/.test(generalTabHtmlAfterDelay);
console.log('General tab content after the delayed identity-fetch resolves (should still be clean, not leaked):', leaked ? 'LEAKED' : 'clean');

await page.unroute('**/api/builders/me');

// Switching back to Build afterward should still work normally — the fix
// only skips a superseded render, not a fresh, current one.
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(
  () => document.getElementById('settings-section').textContent.includes('Land Cap'),
  { timeout: 10000 },
);
const buildTabWorksNormally = (await page.textContent('#settings-section')).includes('Land Cap');
console.log('Build tab still renders Land Cap normally on a fresh, non-superseded switch (should be true):', buildTabWorksNormally);

const pass = !/Land Cap|Redeem Higgles|Active Auctions/.test(generalTabHtmlRightAfterSwitch) &&
  stillOnGeneralTab &&
  !leaked &&
  buildTabWorksNormally &&
  errors.length === 0;
await finish(browser, { pass, label: '#905: a Settings tab switch mid-load does not leak the superseded tab\'s controls', errors });
