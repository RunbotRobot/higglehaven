// #4094 (part of #4075): Settings > Build lists the builder's archived lándlet versions in a closed
// "From an earlier lándlet" row, drawn only when there is one, and "Add to my versions" asks the server to
// add it to this lándlet as one more saved version. The server side (list, restore, who may) is covered by
// worker/archived-versions.test.js; this checks the wiring on the page, with the two routes answered here
// because the local world has no released lándlet to have archived anything.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Archived Versions Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function openBuildSettings() {
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
  // Settings opens on the Build tab in Build mode; clicking the tab would let its handler open every row.
  await page.waitForSelector('#build-publish-status', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(800);
}

// Nothing archived (the real server): no row at all.
await openBuildSettings();
const hiddenWhenNone = await page.evaluate(() => {
  const fold = document.querySelector('.settings-archived-versions');
  return !!fold && fold.hidden;
});
console.log('no archived version: the row is not drawn (should be true):', hiddenWhenNone);
await page.click('#settings-close-btn');

let restoreBody = null;
await page.route('**/api/builders/me/archived-versions', async (route) => {
  await route.fulfill({
    json: { archivedVersions: [{ versionId: 'arch-1', sourceLandletId: null, versionNumber: 3, name: 'Old wall', instanceCount: 12, metadata: {}, createdAt: '2026-11-01T00:00:00.000Z' }] },
  });
});
await page.route('**/api/builders/me/archived-versions/arch-1/restore', async (route) => {
  restoreBody = JSON.parse(route.request().postData() || '{}');
  await route.fulfill({ status: 201, json: { version: { versionId: 'v-new', landletId: restoreBody.landletId, versionNumber: 1, name: 'Restored: Old wall', instanceCount: 12, metadata: {}, createdAt: '2026-11-24T00:00:00.000Z' } } });
});

await openBuildSettings();
const shown = await page.evaluate(() => {
  const fold = document.querySelector('.settings-archived-versions');
  return {
    visible: !!fold && !fold.hidden,
    summary: fold?.querySelector('summary')?.textContent.trim(),
    row: fold?.querySelector('.version-row-info')?.textContent,
  };
});
console.log('one archived version: row drawn (should be true):', shown.visible, JSON.stringify(shown));
// (The row is a closed <details> with no script that opens it; the test harness opens closed rows whenever a click
// is waiting on one, see budAware in e2e/helpers.mjs, so it is not asserted closed here.)
await page.click('.settings-archived-versions > summary');
await page.click('.settings-archived-versions .version-action-btn:has-text("Add to my versions")');
await page.waitForFunction(() => document.getElementById('build-publish-status')?.textContent.includes('Saved as'), null, { timeout: 15000 });
const status = (await page.textContent('#build-publish-status')).trim();
console.log('status after adding:', status, JSON.stringify(restoreBody));

const pass = hiddenWhenNone
  && shown.visible && shown.summary === 'From an earlier lándlet' && /Old wall — 12 items/.test(shown.row)
  && typeof restoreBody?.landletId === 'string' && restoreBody.landletId.length > 0
  && status.includes('Restored: Old wall') && errors.length === 0;
await finish(browser, { pass, label: 'Settings > Build lists archived lándlet versions in a closed row and adds one to this lándlet (#4094)', errors });
