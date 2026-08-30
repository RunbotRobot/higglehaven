// A shared bundle should be visible (and placeable) by a completely
// different builder in the Community tab, but that other builder should
// never see delete/share controls on a bundle they don't own. The backend
// itself now also enforces this (PATCH/DELETE require session-authenticated
// ownership — see handleBundles' own comment in worker/index.js); this test
// covers the frontend hiding those controls in the first place, since a
// builder should never even be offered a button that would 403.
// Two independent browser pages stand in for two different real users,
// rather than juggling a mid-test identity switch on one page.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const SHARER = 'Bundle Sharer';
const VIEWER = 'Bundle Viewer';
const BUNDLE_NAME = SHARER; // launchPage's dialog handler answers every prompt() with promptAnswer

const sharerSession = await launchPage({ promptAnswer: SHARER });
const viewerSession = await launchPage({ promptAnswer: VIEWER });
const errors = [...sharerSession.errors, ...viewerSession.errors];

// --- Sharer: place one item, save it as a SHARED bundle. ---
const sharerPage = sharerSession.page;
await chooseIdentity(sharerPage, { mode: 'build', label: SHARER, isNew: true });
await claimLandlet(sharerPage);

await sharerPage.click('#add-item-btn');
await sharerPage.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await sharerPage.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await sharerPage.waitForTimeout(300);
await sharerPage.mouse.click(210, 400);
await sharerPage.waitForTimeout(800);

// Placing already auto-selected the tree (handlePlacementClick's own
// selectOnly) — Multi-Select carries that selection in, nothing more to tap.
await sharerPage.click('#toggle-multiselect');
await sharerPage.waitForTimeout(300);
await sharerPage.click('#save-bundle-item');
// launchPage's dialog handler auto-accepts confirm() too, which is exactly
// the "share it" path this test wants (the Save Bundle handler's confirm()
// asks whether to share).
await sharerPage.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), { timeout: 10000 });
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
