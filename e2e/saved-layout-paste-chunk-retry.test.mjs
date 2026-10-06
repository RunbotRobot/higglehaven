// Regression test for #1362: layoutPreviewPasteBtn's click handler ignored
// createInstancesRemote's own #903 err.succeededCount and never pruned
// selectedSavedInstanceIds on a partial failure, unlike its sibling
// syncBatchCreate (src/main.js's #903 fix). createInstancesRemote chunks a
// paste into groups of INSTANCE_BATCH_CHUNK_SIZE (100) sequential POSTs —
// if a later chunk fails after an earlier one already committed, the old
// code resubmitted the ENTIRE original selection on retry (ids are always
// stripped before submission, so the server just assigns fresh ones),
// duplicating everything from the already-succeeded chunk.
//
// A real 101-instance saved layout is built via the same "place on a level,
// then remove that level" sweep the existing e2e/saved-layout-paste.test.mjs
// already uses (worker/index.js's handleLevelRemove has no cap on how many
// out-of-range instances it sweeps into one saved layout) -- real data, not
// mocked. The one piece that needs mocking is making the SECOND of the two
// chunked POST /api/instances/batch requests fail deterministically (the
// real validation paths that could fail a chunk depend on timing/races this
// test doesn't need) -- the first chunk's 100 items still hit the real
// server and really commit, so what's under test (whether the frontend
// correctly accounts for that real partial success) is exercised for real.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, grantLandCapHeadroomAsAdmin } from './helpers.mjs';

const LABEL = 'Saved Layout Chunk Retry Tester';
const LEVEL_HEIGHT_M = 10;
const INSTANCE_COUNT = 101;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

let lastAlertMessage = null;
page.on('dialog', (dialog) => { if (dialog.type() === 'alert') lastAlertMessage = dialog.message(); });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// GET /api/instances caps limit at 100 (queryLimit) -- pages through with
// its own cursor to count more than that, mirroring fetchAllAuctions'/
// fetchAllLandlets' own client-side pagination shape.
async function fetchAllInstances(landletId) {
  const all = [];
  let cursor;
  for (;;) {
    const query = `landletId=${landletId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { body } = await fetchJson(`/api/instances?${query}`);
    all.push(...body.instances);
    if (!body.nextCursor) return all;
    cursor = body.nextCursor;
  }
}

const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
await grantLandCapHeadroomAsAdmin(me.builderId);

const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const landletId = landlets[0].landletId;

await fetchJson(`/api/landlets/${landletId}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});

// 101 instances, tightly spaced (no server-side overlap check exists, per
// #846) well within the claimed landlet's bounds -- same z as the existing
// single-instance saved-layout-paste test's own (x:2,y:3,z:15), which
// already confirmed that position is valid on a freshly claimed landlet.
const instances = Array.from({ length: INSTANCE_COUNT }, (_, i) => ({
  instanceId: `chunk-retry-source-${i}`,
  landletId,
  templateId: 'placeholder-tree',
  x: 1 + i * 0.02,
  y: 3,
  z: LEVEL_HEIGHT_M * 1.5,
}));
const firstBatch = await fetchJson('/api/instances/batch', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instances: instances.slice(0, 100) }),
});
const secondBatch = await fetchJson('/api/instances/batch', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instances: instances.slice(100) }),
});
console.log('created the 101 source instances (both statuses should be 201):', firstBatch.status, secondBatch.status);

const levelRemoved = await fetchJson(`/api/landlets/${landletId}/levels/1`, { method: 'DELETE' });
console.log('removed the level, sweeping all 101 into a saved layout (should be 200):', levelRemoved.status);

// Re-purchase the level so the target (same) landlet's z-bounds cover the
// saved z again -- the landlet now has zero instances (the sweep deletes
// the originals from placed_instances), a clean slate to paste back onto.
await fetchJson(`/api/landlets/${landletId}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});
const instancesBeforePaste = await fetchAllInstances(landletId);
console.log('landlet instance count before any paste (should be 0):', instancesBeforePaste.length);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, { timeout: 10000 });
const savedLayoutRow = page.locator('.settings-field', { hasText: 'Saved Layouts' }).locator('.version-row');
await savedLayoutRow.locator('button', { hasText: 'Preview' }).click();
await page.waitForFunction(() => document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), { timeout: 15000 });
await page.waitForTimeout(1000);

await page.mouse.move(10, 10);
await page.mouse.down();
await page.mouse.move(410, 850, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const selectionAfterDrag = await page.locator('#layout-preview-selection-count').textContent();
console.log(`selection count after marquee-drag (should include "${INSTANCE_COUNT} selected"):`, selectionAfterDrag);

// Let the first chunk (100 items) really hit the server and really commit
// -- only the second chunk (the 101st item) is forced to fail, simulating
// the exact "later chunk fails after an earlier one already committed"
// shape #903 already documented for createInstancesRemote.
let batchPostCount = 0;
await page.route('**/api/instances/batch', async (route) => {
  if (route.request().method() !== 'POST') {
    await route.continue();
    return;
  }
  batchPostCount++;
  if (batchPostCount === 2) {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Simulated mid-chunk failure for the #1362 regression test' }),
    });
    return;
  }
  await route.continue();
});

await page.click('#layout-preview-paste-btn');
await page.waitForFunction(() => document.getElementById('layout-preview-paste-btn') && !document.getElementById('layout-preview-paste-btn').disabled, { timeout: 15000 });
console.log('alert shown after the partial failure:', lastAlertMessage);
const alertMentionsPartialSuccess = Boolean(lastAlertMessage) && lastAlertMessage.includes('100') && lastAlertMessage.includes('1 failed');

const instancesAfterFirstAttempt = await fetchAllInstances(landletId);
console.log('landlet instance count after the first (partially-failed) paste attempt (should be 100):', instancesAfterFirstAttempt.length);

// Real server from here on -- no more mocking. Click Paste again, the same
// way a builder would retry after seeing the alert.
await page.unroute('**/api/instances/batch');
await page.click('#layout-preview-paste-btn');
await page.waitForFunction(() => !document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), { timeout: 15000 });
await page.waitForSelector('#add-item-btn', { timeout: 10000 });

const instancesAfterRetry = await fetchAllInstances(landletId);
console.log(`landlet instance count after retrying (should be ${INSTANCE_COUNT} -- was ${INSTANCE_COUNT + 100} when the retry resent everything, the #1362 bug):`, instancesAfterRetry.length);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass =
  firstBatch.status === 201 &&
  secondBatch.status === 201 &&
  levelRemoved.status === 200 &&
  instancesBeforePaste.length === 0 &&
  selectionAfterDrag.includes(`${INSTANCE_COUNT} selected`) &&
  alertMentionsPartialSuccess &&
  instancesAfterFirstAttempt.length === 100 &&
  instancesAfterRetry.length === INSTANCE_COUNT &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Retrying a partially-failed saved-layout paste only resends what did not already land (#1362)', errors });
