// Regression test for #448: the Version History panel's renderVersionHistory()
// had no stale-response guard, unlike its sibling friendsLoadToken/
// signPostsLoadToken/calendarEventsLoadToken panels — clicking "Set Live" on
// one row and then "Publish" in quick succession could let Set Live's
// slower, now-stale re-render land after Publish's fresher one and silently
// overwrite the panel with the wrong "live" version. Sends the GET
// /api/landlets/:id fetch that Set Live's own re-render fires right away
// (via Playwright route interception's route.fetch(), so the captured
// response genuinely reflects server state as of Set Live's own change)
// but delays *delivering* that response to the page until after Publish's
// own, faster round trip has already rendered — the exact reordering the
// issue describes.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Version History Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeCatalogItem(name, x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: name }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1000);
}

async function fetchJson(pathAndQuery) {
  return page.evaluate(async (p) => (await fetch(p)).json(), pathAndQuery);
}

async function openBuildSettings() {
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
  await page.click('.settings-tab-btn[data-section="build"]');
  await page.waitForTimeout(500);
}

// Publish once — version 1 (live).
await placeCatalogItem('Tree', 210, 400);
await openBuildSettings();
await page.click('.version-action-btn:has-text("Publish")');
await page.waitForFunction(
  () => document.getElementById('build-publish-status')?.textContent.includes('Published'),
  { timeout: 10000 },
);
await page.waitForTimeout(500);

// Publish again — version 2 (live), version 1 now has an enabled Set Live.
await page.click('#settings-close-btn');
await page.waitForTimeout(300);
await placeCatalogItem('Brick', 250, 420);
await openBuildSettings();
await page.click('.version-action-btn:has-text("Publish")');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 2, { timeout: 10000 });
await page.waitForTimeout(500);

const { landlets } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.ownerBuilderId && l.activeVersionId);

// Delay only the FIRST GET to the single-landlet endpoint (no query string,
// so this doesn't also match the `?limit=100` list fetch above) issued
// after this point — that's the one Set Live's own re-render fires below.
// Actually *sends* the request right away (via route.fetch()), so the
// captured response reflects true server state at that moment (still
// version 1 active) — only *delivering* it back to the page is delayed.
// Delaying the dispatch instead (route.continue() after a sleep) would be
// the wrong shape here: renderVersionHistory() does a full historyList
// innerHTML clear-and-rebuild on every call, so a request that's merely
// sent late would just re-fetch (and correctly re-render) whatever is
// true *by then* — no visible bug. The real bug is a request answered
// truthfully as of when it was sent, delivered stale after a fresher one.
let getLandletCount = 0;
await page.route(`**/api/landlets/${myLandlet.landletId}`, async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getLandletCount++;
  if (getLandletCount !== 1) {
    await route.continue();
    return;
  }
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.fulfill({ response });
});

// Click "Set Live" on the older (version 1) row — fires activateLandletVersion,
// then a re-render whose GET /api/landlets/:id is the delayed one above.
const olderRow = page.locator('.version-row').last(); // oldest listed last (newest-first)
await olderRow.locator('button', { hasText: 'Set Live' }).click();

// Immediately (without waiting for the above to settle) click "Publish" —
// its own save+activate+re-render round trip is NOT delayed, so it should
// finish first and correctly show the brand-new version as live.
await page.click('.version-action-btn:has-text("Publish")');
await page.waitForFunction(
  () => document.getElementById('build-publish-status')?.textContent.includes('Published'),
  { timeout: 10000 },
);
await page.waitForTimeout(300);

const liveRowTextRightAfterPublish = await page.locator('.version-row').filter({ hasText: '— live' }).first().locator('.version-row-info').textContent();
console.log('row showing "— live" right after Publish resolves (should be the newest, 2-item version):', liveRowTextRightAfterPublish);

// Wait long enough for Set Live's delayed, now-stale re-render to land too.
await page.waitForTimeout(2000);

const liveRows = page.locator('.version-row').filter({ hasText: '— live' });
const liveRowCountAfterStaleLands = await liveRows.count();
const liveRowTextAfterStaleLands = await liveRows.first().locator('.version-row-info').textContent();
console.log('exactly one row still shows "— live" after the stale, delayed response lands (should be 1):', liveRowCountAfterStaleLands);
console.log('that row is still the newest, 2-item version, not reverted to the 1-item version Set Live targeted:', liveRowTextAfterStaleLands);

const { landlets: landletsAfterRace } = await fetchJson('/api/landlets?limit=100');
const activeVersionIdAfterRace = landletsAfterRace.find((l) => l.landletId === myLandlet.landletId).activeVersionId;
const { version: liveVersionAfterRace } = await fetchJson(`/api/landlets/${myLandlet.landletId}/versions/${activeVersionIdAfterRace}`);
console.log('server-side activeVersionId after the race matches the DOM (should be the 2-item Publish version, not the 1-item Set Live targeted):', liveVersionAfterRace.instanceCount);

const pass = liveRowCountAfterStaleLands === 1 &&
  liveRowTextAfterStaleLands.includes('2 items') &&
  liveVersionAfterRace.instanceCount === 2 &&
  errors.length === 0;
await finish(browser, { pass, label: '#448: a slow, stale Version History re-render does not overwrite a fresher Publish', errors });
