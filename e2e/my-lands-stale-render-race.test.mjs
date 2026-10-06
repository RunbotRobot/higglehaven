// Regression test for #1378: renderMyLands() had no stale-response guard,
// unlike its sibling friendsLoadToken/notificationsLoadToken/
// versionHistoryLoadToken panels (and #1348's drawFriendsMap fix for the
// exact same shape) -- opening the My Lands modal, closing it, and
// reopening it before the first call's own fetchAllLandlets() round trip
// resolved let an earlier (slower) call's stale response land after a
// fresher one and silently overwrite the panel with outdated data.
//
// Delays only the delivery of the FIRST GET to the owned-landlets list
// endpoint (route.fetch() then a sleep then route.fulfill(), the same idiom
// e2e/version-history-race.test.mjs and e2e/friends-map-stale-render-race.test.mjs
// already use) so it captures real server state as of when it was sent (the
// land's original name) but arrives after a second, fresher call's render
// (showing the renamed land) has already landed.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'My Lands Race Tester';
const RENAMED = 'Renamed While Stale Fetch In Flight';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery) {
  return page.evaluate(async (p) => (await fetch(p)).json(), pathAndQuery);
}

const { landlets } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const originalName = myLandlet.name;

// Only the owned-landlets list fetch renderMyLands() issues carries both of
// these query params together -- narrow enough to not also catch an
// unrelated /api/landlets?limit=100 call elsewhere on the page.
let getOwnedCount = 0;
await page.route('**/api/landlets?*', async (route) => {
  const url = new URL(route.request().url());
  if (route.request().method() !== 'GET' || !url.searchParams.has('ownerBuilderId') || url.searchParams.get('status') !== 'claimed') {
    await route.continue();
    return;
  }
  getOwnedCount++;
  if (getOwnedCount !== 1) {
    await route.continue();
    return;
  }
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.fulfill({ response });
});

// First open -- fires renderMyLands() #1, whose GET is the delayed one above.
await openAccountMenu(page);
await page.click('#my-lands-btn');
await page.waitForSelector('#my-lands-modal.visible', { timeout: 5000 });
await page.click('#my-lands-close-btn');

// Rename the land while call #1's response is still in flight -- a real
// server-side change a fresher render must reflect.
await page.evaluate(async ({ id, name }) => {
  await fetch(`/api/landlets/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}, { id: myLandlet.landletId, name: RENAMED });

// Second open (not delayed) -- fires renderMyLands() #2, which should finish
// first and correctly show the renamed land.
await openAccountMenu(page);
await page.click('#my-lands-btn');
await page.waitForSelector('#my-lands-modal.visible', { timeout: 5000 });
await page.waitForFunction(
  (name) => document.getElementById('my-lands-list')?.textContent.includes(name),
  RENAMED,
  { timeout: 5000 },
);

const nameRightAfterSecondOpen = await page.textContent('#my-lands-list');
console.log('list shows the renamed land right after the second (fresh) open:', nameRightAfterSecondOpen.includes(RENAMED));

// Wait long enough for call #1's delayed, now-stale response to land too.
await page.waitForTimeout(2000);

const listTextAfterStaleLands = await page.textContent('#my-lands-list');
console.log('list still shows the renamed land, not reverted to the original name, after the stale response lands:', listTextAfterStaleLands.includes(RENAMED) && !listTextAfterStaleLands.includes(originalName));

const pass = nameRightAfterSecondOpen.includes(RENAMED) &&
  listTextAfterStaleLands.includes(RENAMED) &&
  !listTextAfterStaleLands.includes(originalName) &&
  errors.length === 0;
await finish(browser, { pass, label: '#1378: a slow, stale My Lands re-render does not overwrite a fresher one', errors });
