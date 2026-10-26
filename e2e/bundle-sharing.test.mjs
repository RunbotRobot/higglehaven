// A shared bundle should be visible (and placeable) by a completely
// different builder in the Community tab, but that other builder should
// never see delete/share controls on a bundle they don't own. The backend
// itself now also enforces this (PATCH/DELETE require session-authenticated
// ownership — see handleBundles' own comment in worker/index.js); this test
// covers the frontend hiding those controls in the first place, since a
// builder should never even be offered a button that would 403.
// Two independent browser pages stand in for two different real users,
// rather than juggling a mid-test identity switch on one page.
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs } from './helpers.mjs';

const SHARER = 'Bundle Sharer';
const VIEWER = 'Bundle Viewer';
const BUNDLE_NAME = SHARER;

const sharerSession = await launchPage({ promptAnswer: SHARER });
const viewerSession = await launchPage({ promptAnswer: VIEWER });

// --- Sharer: place one item, save it as a SHARED bundle. ---
const sharerPage = sharerSession.page;
await chooseIdentity(sharerPage, { mode: 'build', label: SHARER, isNew: true });
await claimLandlet(sharerPage);

await sharerPage.click('#add-item-btn');
await sharerPage.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await sharerPage.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await sharerPage.waitForTimeout(300);
await sharerPage.mouse.click(210, 400);
// Placement itself (spawnInstanceAt in src/main.js) is async — it loads/
// parses the tree model (a real network fetch the first time any test in
// this process places one) before calling selectOnly on it — so a fixed
// sleep here is a race: under load (slow model fetch/parse, a loaded CI
// runner — see run-all.mjs's own comment on request times spiking well
// past their usual 10-70ms there), toggling Multi-Select below could fire
// before that selectOnly ever happens, carrying an empty selection into
// Multi-Select mode instead of the tree. Waiting for the actual selection
// text (the single selected item's own name, exactly what updateSelectionUI
// sets product-info to for a 1-item selection) makes this deterministic
// instead of guessing a delay that's long enough.
//
// #2142 (sub-issue of #2138): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real
// applied timeout was always Playwright's actual default (30000ms), never
// the smaller number written here. The explicit `null` arg reaches the
// options slot, and the timeout itself is widened to 60000ms for real
// headroom under CI load, same as e2e/helpers.mjs's own account-menu-modal
// wait.
await sharerPage.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), null, { timeout: 60000 });

// Placing already auto-selected the tree (handlePlacementClick's own
// selectOnly) — Multi-Select carries that selection in (confirmed: see the
// multiSelectBtn click handler's own comment in src/main.js — "Whatever's
// already selected carries into (and out of) multi-select rather than
// being cleared"), nothing more to tap.
await sharerPage.click('#toggle-multiselect');
await sharerPage.waitForTimeout(300);
// Shared, which is exactly the "share it" path this test wants.
await saveBundleAs(sharerPage, BUNDLE_NAME, { shared: true });
await sharerPage.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });
const savedStatus = await sharerPage.textContent('#product-info');
console.log('save status (should mention Saved):', savedStatus);

// The sharer's own bundle shows in both their My Bundles and Community tabs.
await sharerPage.click('#add-item-btn');
await sharerPage.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await sharerPage.click('.bundle-tab-btn[data-bundle-tab="community"]');
await sharerPage.waitForTimeout(300);
const sharerSeesOwnInCommunity = await sharerPage.locator('.bundle-tile').filter({ hasText: BUNDLE_NAME }).count();
console.log('sharer sees their own bundle in the Community tab too (should be 1):', sharerSeesOwnInCommunity);
await sharerPage.click('#catalog-picker-close-btn');
await sharerPage.waitForTimeout(300);

// --- Viewer: a completely different builder, own landlet, own session. ---
const viewerPage = viewerSession.page;
await chooseIdentity(viewerPage, { mode: 'build', label: VIEWER, isNew: true });
await claimLandlet(viewerPage);

await viewerPage.click('#add-item-btn');
await viewerPage.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
// Nothing of the viewer's own yet — My Bundles (the default tab) is empty,
// but the section itself is visible because the Sharer's bundle exists.
const myBundlesEmptyForViewer = await viewerPage.locator('#bundle-picker-empty').isVisible();
console.log('viewer\'s own My Bundles tab is empty (should be true):', myBundlesEmptyForViewer);

await viewerPage.click('.bundle-tab-btn[data-bundle-tab="community"]');
await viewerPage.waitForTimeout(300);
const communityTile = viewerPage.locator('.bundle-tile').filter({ hasText: BUNDLE_NAME });
const viewerSeesSharedBundle = await communityTile.count();
console.log('viewer sees the shared bundle in Community (should be 1):', viewerSeesSharedBundle);
const deleteBtnVisibleToViewer = await communityTile.locator('.bundle-tile-delete').count();
console.log('viewer sees NO owner-only controls on a bundle they don\'t own (should be 0):', deleteBtnVisibleToViewer);

// The viewer can still place someone else's shared bundle.
await communityTile.locator('.bundle-tile-place').click();
await viewerPage.waitForTimeout(300);
await viewerPage.mouse.click(210, 500);
await viewerPage.waitForTimeout(1000);
const viewerPlacedInfo = await viewerPage.textContent('#product-info');
console.log('info after viewer places the shared bundle (should mention the placed template):', viewerPlacedInfo);

// Assembled here, after every interaction has happened, rather than at
// launch time -- #2735: a spread copy taken right after launchPage() would
// freeze on the still-empty source arrays and never see a real error.
const errors = [...sharerSession.errors, ...viewerSession.errors];
const pass = savedStatus.includes('Saved') &&
  sharerSeesOwnInCommunity === 1 &&
  myBundlesEmptyForViewer &&
  viewerSeesSharedBundle === 1 &&
  deleteBtnVisibleToViewer === 0 &&
  viewerPlacedInfo.includes('Tree') &&
  errors.length === 0;
// finish() closes sharerSession.browser itself and exits the process, so
// the viewer's browser has to be closed first — nothing after finish()
// ever runs.
await viewerSession.browser.close();
await finish(sharerSession.browser, { pass, label: 'shared bundles are visible/placeable but not deletable by other builders', errors });
