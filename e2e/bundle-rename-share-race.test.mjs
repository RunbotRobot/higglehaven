// Regression test for #1349: the rename and share-toggle handlers each do
// their own updateBundle -> refetch-both-lists -> renderBundlePicker()
// round trip against the same shared myBundles/communityBundles state,
// with no mutual exclusion between them. Renaming one bundle while a
// share-toggle on a *different* bundle is still mid-refetch could have the
// slower refetch land last and redraw from a stale snapshot, undoing the
// other bundle's already-applied change in the UI (self-correcting on the
// next unrelated reload, but visibly wrong until then).
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs, fillBundleNameModal } from './helpers.mjs';

const LABEL = 'Bundle Race Tester';
const BUNDLE_A = 'Race Bundle A';
const BUNDLE_B = 'Race Bundle B';
const BUNDLE_A_RENAMED = 'Race Bundle A Renamed';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeAndSaveBundle(name, x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  // #2142 (sub-issue of #2138): waitForFunction's signature is (pageFunction,
  // arg, options) -- a bare (fn, { timeout }) call puts the options object
  // in the `arg` slot instead, so `options` stayed undefined and the real
  // applied timeout was always Playwright's actual default (30000ms), never
  // the smaller number written here. The explicit `null` arg reaches the
  // options slot, and the timeout itself is widened to 60000ms for real
  // headroom under CI load, same as e2e/helpers.mjs's own account-menu-modal
  // wait.
  await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), null, { timeout: 60000 });
  await page.click('#toggle-multiselect');
  await page.waitForTimeout(300);
  // Both bundles start shared -- the rest of this test exercises a
  // share-toggle race, which needs a real "currently shared" starting
  // point for Bundle B.
  await saveBundleAs(page, name, { shared: true });
  await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });
  await page.click('#toggle-multiselect'); // back out before the next placement
  await page.waitForTimeout(300);
}

await placeAndSaveBundle(BUNDLE_A, 150, 400);
await placeAndSaveBundle(BUNDLE_B, 270, 400);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.waitForSelector('.bundle-tile', { timeout: 10000 });

// Delay only the FIRST two GET /api/bundles* requests from this point on --
// Bundle A's own refetch pair (fetchBundles + fetchSharedBundles), fired
// right after its rename's PATCH resolves below -- so they're still in
// flight when Bundle B's share-toggle (fired immediately after, its own
// refetch left undelayed) completes and renders first. Without #1349's
// fix, Bundle A's delayed refetch would then land last and redraw from a
// snapshot that predates Bundle B's already-applied share change.
// route.continue() delaying *before* dispatching would delay the server's
// own read too -- the opposite of what's needed (B's PATCH would then
// land before A's GET ever reaches the server, so A's response would
// correctly include B's change, not reproduce the stale-snapshot race).
// route.fetch() performs the real request right away instead, capturing
// the server's response at the correct (early) time; only *delivering*
// that already-fetched response to the page is delayed via fulfill().
let getBundlesCalls = 0;
await page.route('**/api/bundles?*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getBundlesCalls += 1;
  const response = await route.fetch();
  if (getBundlesCalls <= 2) await new Promise((resolve) => setTimeout(resolve, 3000));
  await route.fulfill({ response });
});

const tile = (name) => page.locator('.bundle-tile').filter({ hasText: name });

await tile(BUNDLE_A).locator('.bundle-tile-rename').click();
await fillBundleNameModal(page, BUNDLE_A_RENAMED);
// Don't wait for A's rename to settle -- fire B's share-toggle right away,
// while A's own (delayed) refetch is still in flight.
await page.waitForTimeout(200);
await tile(BUNDLE_B).locator('.bundle-tile-share').click();

// B's own (undelayed) refetch+render should land first, showing its new
// unshared state (it started shared, per Save Bundle's auto-accepted
// confirm() above) -- aria-label flips from "Stop sharing" to "Share ...".
await page.waitForFunction(
  (name) => {
    const el = Array.from(document.querySelectorAll('.bundle-tile')).find((t) => t.textContent.includes(name));
    return el?.querySelector('.bundle-tile-share')?.getAttribute('aria-label')?.startsWith('Share ');
  },
  BUNDLE_B,
  { timeout: 10000 },
);
const bRightAfterOwnToggle = await tile(BUNDLE_B).locator('.bundle-tile-share').getAttribute('aria-label');
console.log('Bundle B share button right after its own toggle (should start with "Share "):', bRightAfterOwnToggle);

// Now wait out A's delayed refetch too, and confirm it didn't clobber B's
// already-applied change back to "still shared" in the UI. Can't wait on
// BUNDLE_A_RENAMED appearing as the signal -- B's own (undelayed) refetch
// above already picks up A's already-committed rename (B's refetch runs
// well after A's PATCH, just before A's own GET response is delivered),
// so that text shows up immediately and would make this check run far too
// early, before A's 3s-delayed fulfill() ever lands.
await page.waitForTimeout(3500);
const bAfterASettles = await tile(BUNDLE_B).locator('.bundle-tile-share').getAttribute('aria-label');
console.log('Bundle B share button after A\'s delayed refetch also settles (should still start with "Share ", not reverted):', bAfterASettles);
const aShowsRenamed = (await tile(BUNDLE_A_RENAMED).count()) === 1;
console.log('Bundle A shows its renamed name (should be true):', aShowsRenamed);

const pass = bRightAfterOwnToggle.startsWith('Share ') &&
  bAfterASettles.startsWith('Share ') &&
  aShowsRenamed &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: "#1349: a bundle's rename/share-toggle refetch doesn't clobber a different bundle's own already-applied change",
  errors,
});
