// #1215: the Saved Layouts settings panel (#634/#635) always fetched
// exactly one page of 20 via `fetchSavedLayouts({ limit: 20 })` and never
// read the response's own `nextCursor` — anything past the 20th saved
// layout was permanently invisible in the UI even though
// GET /api/builders/me/saved-layouts already fully supports cursor
// pagination (the same shape GET /api/notifications uses). Fixed by
// mirroring notifications' own Load More pattern.
//
// Creating 21 REAL saved layouts to exercise this isn't actually possible
// in one test run: every level-removal that sweeps instances into a new
// saved layout spends from SAVED_LAYOUT_CREATE_RATE_LIMIT_MAX (20 per 15
// minutes, worker/index.js's handleLandletLevels DELETE branch) — the
// production abuse guard itself caps real creation at exactly the panel's
// own page size, so a 21st real one can't be created within a single CI
// run. The bug being tested is purely frontend (renderSavedLayoutsList
// never reads nextCursor at all), so this mocks
// GET /api/builders/me/saved-layouts via page.route() instead (same
// technique already used by e.g. e2e/connectivity-indicator-out-of-order.
// test.mjs, e2e/version-history-race.test.mjs) to serve two fabricated
// pages — this tests the exact frontend gap without fighting a real,
// intentional server-side rate limit that has nothing to do with it.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Layout Pagination Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

function fakeSavedLayout(i) {
  return { savedLayoutId: `fake-saved-layout-${i}`, name: `Level ${i}`, instanceCount: 1 };
}

const requestedCursors = [];
await page.route('**/api/builders/me/saved-layouts*', async (route) => {
  const url = new URL(route.request().url());
  const cursor = url.searchParams.get('cursor');
  requestedCursors.push(cursor);
  if (!cursor) {
    // First page: exactly 20 rows (the panel's own page size), plus a
    // cursor pointing at one more page.
    const savedLayouts = Array.from({ length: 20 }, (_, i) => fakeSavedLayout(i));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ savedLayouts, nextCursor: 'fake-cursor-page-2' }),
    });
    return;
  }
  if (cursor === 'fake-cursor-page-2') {
    // Second (last) page: one more row, no further cursor.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ savedLayouts: [fakeSavedLayout(20)], nextCursor: null }),
    });
    return;
  }
  // Any other cursor means the implementation is looping/re-requesting in
  // a way this test didn't expect — fail loudly rather than silently
  // serving something that could mask a bug.
  await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected cursor in test mock' }) });
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(() => document.getElementById('saved-layouts-load-more-btn') != null, { timeout: 10000 });

const savedLayoutsField = page.locator('.settings-field', { hasText: 'Saved Layouts' });
const loadMoreBtn = page.locator('#saved-layouts-load-more-btn');

// First (mocked) page: exactly 20 rows, Load More visible since the mock
// reported a next page.
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.settings-field')).find((f) => f.textContent.includes('Saved Layouts'))
    ?.querySelectorAll('.version-row').length === 20,
  { timeout: 10000 },
);
const rowCountFirstPage = await savedLayoutsField.locator('.version-row').count();
const loadMoreVisibleFirstPage = await loadMoreBtn.isVisible();
console.log('row count on first (mocked) page (should be 20):', rowCountFirstPage);
console.log('Load More visible after first page (should be true):', loadMoreVisibleFirstPage);

// The Settings panel's own Build section renders itself twice on open
// (once for the modal's own default tab, once for the explicit tab click
// just above) — unrelated to #1215's own pagination scope, so only the
// last render's DOM (already confirmed above) and the cursors requested
// from here on (the actual Load More click) matter; clear what's
// accumulated so far rather than asserting on an unrelated render-count
// quirk.
requestedCursors.length = 0;

// Click Load More: the 21st row appears (appended, not replacing the
// first 20), and since the mock's second page had no nextCursor, the
// button itself hides again.
await loadMoreBtn.click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.settings-field')).find((f) => f.textContent.includes('Saved Layouts'))
    ?.querySelectorAll('.version-row').length === 21,
  { timeout: 10000 },
);
const rowCountAfterLoadMore = await savedLayoutsField.locator('.version-row').count();
const loadMoreHiddenAfterLastPage = !(await loadMoreBtn.isVisible());
const firstRowStillPresentAfterLoadMore = (await savedLayoutsField.locator('.version-row-info').first().textContent())?.includes('Level 0');
console.log('row count after Load More (should be 21):', rowCountAfterLoadMore);
console.log('Load More hidden once there are no more pages (should be true):', loadMoreHiddenAfterLastPage);
console.log('first page row still present after Load More -- rows appended, not replaced (should be true):', firstRowStillPresentAfterLoadMore);
console.log('cursor requested by the Load More click (should be ["fake-cursor-page-2"]):', requestedCursors);

const pass =
  rowCountFirstPage === 20 &&
  loadMoreVisibleFirstPage &&
  rowCountAfterLoadMore === 21 &&
  loadMoreHiddenAfterLastPage &&
  firstRowStillPresentAfterLoadMore &&
  requestedCursors.length === 1 &&
  requestedCursors[0] === 'fake-cursor-page-2' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Saved Layouts panel paginates past the first 20 via Load More (#1215)', errors });
