// #1215: the Saved Layouts settings panel (#634/#635) always fetched
// exactly one page of 20 via `fetchSavedLayouts({ limit: 20 })` and never
// read the response's own `nextCursor` — anything past the 20th saved
// layout was permanently invisible in the UI even though
// GET /api/builders/me/saved-layouts already fully supports cursor
// pagination (the same shape GET /api/notifications uses). Fixed by
// mirroring notifications' own Load More pattern. This is the one piece
// of coverage e2e/saved-layout-preview.test.mjs's single-saved-layout
// setup can't exercise — it needs a real second page to prove the button
// shows up and actually loads more rows.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, grantLandCapHeadroomAsAdmin } from './helpers.mjs';

const LABEL = 'Saved Layouts Load More Tester';
const SAVED_LAYOUT_COUNT = 21; // one more than the panel's own page size (20)

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
await grantLandCapHeadroomAsAdmin(me.builderId);

const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const landletId = landlets[0].landletId;

// Same add-level/place-instance/remove-level cycle
// saved-layout-preview.test.mjs uses for a single saved layout, repeated
// enough times to force a real second page.
let cycleStatusesOk = true;
for (let i = 0; i < SAVED_LAYOUT_COUNT; i++) {
  const levelAdded = await fetchJson(`/api/landlets/${landletId}/levels`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
  });
  const placed = await fetchJson('/api/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: `saved-layouts-load-more-instance-${i}`, landletId, templateId: 'placeholder-tree', x: 1, y: 1, z: 15 }),
  });
  const levelRemoved = await fetchJson(`/api/landlets/${landletId}/levels/1`, { method: 'DELETE' });
  if (levelAdded.status !== 201 || placed.status !== 201 || levelRemoved.status !== 200) cycleStatusesOk = false;
}
console.log(`all ${SAVED_LAYOUT_COUNT} add/place/remove cycles returned the expected statuses (should be true):`, cycleStatusesOk);

const savedLayoutsTotal = (await fetchJson('/api/builders/me/saved-layouts?limit=100')).body.savedLayouts.length;
console.log(`saved layouts actually on record (should be ${SAVED_LAYOUT_COUNT}):`, savedLayoutsTotal);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.settings-field span')).some((el) => el.textContent === 'Saved Layouts'),
  { timeout: 10000 },
);

const savedLayoutsField = page.locator('.settings-field', { hasText: 'Saved Layouts' });
await page.waitForFunction(() => document.getElementById('saved-layouts-load-more-btn') != null, { timeout: 10000 });

// First page: exactly 20 rows, Load More visible (there's a 21st saved
// layout still unseen).
await page.waitForFunction(
  () => document.querySelectorAll('.settings-field').length > 0 &&
    Array.from(document.querySelectorAll('.settings-field')).find((f) => f.textContent.includes('Saved Layouts'))
      ?.querySelectorAll('.version-row').length === 20,
  { timeout: 10000 },
);
const rowCountFirstPage = await savedLayoutsField.locator('.version-row').count();
const loadMoreBtn = page.locator('#saved-layouts-load-more-btn');
const loadMoreVisibleFirstPage = await loadMoreBtn.isVisible();
console.log('row count on first page (should be 20):', rowCountFirstPage);
console.log('Load More visible after first page (should be true):', loadMoreVisibleFirstPage);

// Click Load More: the 21st row appears, and since that was the last
// page, the button itself now hides.
await loadMoreBtn.click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.settings-field')).find((f) => f.textContent.includes('Saved Layouts'))
    ?.querySelectorAll('.version-row').length === 21,
  { timeout: 10000 },
);
const rowCountAfterLoadMore = await savedLayoutsField.locator('.version-row').count();
const loadMoreHiddenAfterLastPage = !(await loadMoreBtn.isVisible());
console.log('row count after Load More (should be 21):', rowCountAfterLoadMore);
console.log('Load More hidden once there are no more pages (should be true):', loadMoreHiddenAfterLastPage);

const pass =
  cycleStatusesOk &&
  savedLayoutsTotal === SAVED_LAYOUT_COUNT &&
  rowCountFirstPage === 20 &&
  loadMoreVisibleFirstPage &&
  rowCountAfterLoadMore === 21 &&
  loadMoreHiddenAfterLastPage &&
  errors.length === 0;
await finish(browser, { pass, label: 'Saved Layouts panel paginates past the first 20 via Load More (#1215)', errors });
