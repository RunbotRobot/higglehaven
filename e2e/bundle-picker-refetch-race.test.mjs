// Regression test for #1349: the bundle-tile rename and share-toggle
// handlers (src/main.js) each independently refetch both bundle lists
// (fetchBundles()/fetchSharedBundles()) and redraw the whole picker after
// their own PATCH succeeds, with no shared guard against the two handlers'
// refetches landing out of order -- unlike every sibling async-render panel
// in this file (renderFriends/renderSignPosts/renderCalendarEvents etc.),
// each of which already uses a monotonic load token for this exact shape.
// Sends the GET /api/bundles request Rename's own refetch fires right away
// (via Playwright route interception's route.fetch(), so the captured
// response genuinely reflects server state as of Rename's own change) but
// delays *delivering* that response to the page until after Share-toggle's
// own, faster round trip has already rendered -- the exact reordering the
// issue describes. Same technique as e2e/version-history-race.test.mjs.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Picker Refetch Race Tester';
const BUNDLE_A_NAME = 'Bundle A';
const BUNDLE_B_NAME = 'Bundle B';
const BUNDLE_A_RENAMED = 'Bundle A Renamed';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

async function saveAsBundle(name) {
  await page.evaluate((n) => {
    window.prompt = () => n;
    window.confirm = () => false; // declining to share -- irrelevant to this race, keeps setup simple
  }, name);
  await page.click('#save-bundle-item');
  await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), { timeout: 10000 });
}

// Each placement auto-selects the newly placed mesh (handlePlacementClick's
// own selectOnly for a 'template' placement) -- no need for Multi-Select to
// save a one-item bundle.
await placeTreeAt(160, 400);
await saveAsBundle(BUNDLE_A_NAME);
await placeTreeAt(260, 400);
await saveAsBundle(BUNDLE_B_NAME);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const initialTileCount = await page.locator('.bundle-tile').count();
console.log('bundle tiles present after saving both (should be 2):', initialTileCount);

const tileFor = (name) => page.locator('.bundle-tile').filter({ hasText: name });

// Delay only the FIRST GET to the (non-shared) bundles list endpoint issued
// after this point -- that's the one Rename's own refetch fires below.
// Actually *sends* the request right away (via route.fetch()), so the
// captured response reflects true server state at that moment (Share-toggle
// on B hasn't happened yet) -- only *delivering* it back to the page is
// delayed. Delaying the dispatch instead (route.continue() after a sleep)
// would be the wrong shape here, per version-history-race.test.mjs's own
// comment on the identical choice: a request merely sent late would just
// fetch (and correctly render) whatever is true by then -- no visible bug.
let getBundlesCount = 0;
await page.route('**/api/bundles?limit=*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getBundlesCount++;
  if (getBundlesCount !== 1) {
    await route.continue();
    return;
  }
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.fulfill({ response });
});

// Rename A -- fires its own PATCH (fast) then the delayed refetch above.
await page.evaluate((n) => { window.prompt = () => n; }, BUNDLE_A_RENAMED);
await tileFor(BUNDLE_A_NAME).locator('.bundle-tile-rename').click();

// Immediately (without waiting for the above to settle), toggle sharing on
// B -- its own PATCH+refetch+render round trip is NOT delayed, so it should
// finish first and correctly show B as shared.
await tileFor(BUNDLE_B_NAME).locator('.bundle-tile-share').click();
await page.waitForFunction(
  (name) => {
    const tile = [...document.querySelectorAll('.bundle-tile')].find((el) => el.textContent.includes(name));
    return tile?.querySelector('.bundle-tile-share')?.getAttribute('aria-label')?.startsWith('Stop sharing');
  },
  BUNDLE_B_NAME,
  { timeout: 10000 },
);
const bShareLabelRightAfterToggle = await tileFor(BUNDLE_B_NAME).locator('.bundle-tile-share').getAttribute('aria-label');
console.log('B\'s share button aria-label right after toggling (should say "Stop sharing..."):', bShareLabelRightAfterToggle);

// Wait long enough for A's delayed, now-stale (relative to B's already-
// rendered change) refetch to land too.
await page.waitForTimeout(2500);

const tileCountAfterStaleLands = await page.locator('.bundle-tile').count();
const bShareLabelAfterStaleLands = await tileFor(BUNDLE_B_NAME).locator('.bundle-tile-share').getAttribute('aria-label');
const aTileTextAfterStaleLands = await tileFor(BUNDLE_A_RENAMED).count();
console.log('tile count after the stale response lands (should still be 2, not a duplicate):', tileCountAfterStaleLands);
console.log('B\'s share button aria-label after the stale response lands (should STILL say "Stop sharing...", not reverted):', bShareLabelAfterStaleLands);
console.log('A\'s own rename is also still visible (should be 1):', aTileTextAfterStaleLands);

const pass =
  initialTileCount === 2 &&
  bShareLabelRightAfterToggle.startsWith('Stop sharing') &&
  tileCountAfterStaleLands === 2 &&
  bShareLabelAfterStaleLands.startsWith('Stop sharing') &&
  aTileTextAfterStaleLands === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: "#1349: a stale, delayed bundle-rename refetch does not clobber a fresher share-toggle", errors });
