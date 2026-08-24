// Wires the already-existing backend draft/version/publish system (see
// docs/API.md's "Landlet drafts"/"Landlet versions") into the frontend for
// the first time: Publish + Version History live in the Settings modal's
// Build tab. Covers the actual point of the split — Shop mode reads the
// frozen published snapshot, not the builder's own further live edits —
// plus Set Live (repoint without touching the editor) and Restore to
// Editor (replace the live draft with an older snapshot).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Publish Suite Tester';

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

async function fetchJson(path) {
  return page.evaluate(async (p) => (await fetch(p)).json(), path);
}

await placeCatalogItem('Tree', 210, 400);

// Publish: creates and activates a version snapshot of the current draft.
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForTimeout(500);
await page.click('.version-action-btn:has-text("Publish")');
await page.waitForFunction(
  () => document.getElementById('build-publish-status')?.textContent.includes('Published'),
  { timeout: 10000 },
);
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, { timeout: 10000 });
const historyAfterFirstPublish = await page.locator('.version-row').count();
const firstRowText = await page.locator('.version-row').first().locator('.version-row-info').textContent();
const setLiveDisabledOnLiveRow = await page.locator('.version-row').first().locator('button', { hasText: 'Set Live' }).isDisabled();
console.log('version rows after first publish (should be 1):', historyAfterFirstPublish);
console.log('first row text (should mention 1 item and "live"):', firstRowText);
console.log('Set Live disabled on the already-live row (should be true):', setLiveDisabledOnLiveRow);

await page.click('#settings-close-btn');
await page.waitForTimeout(300);

// Place a SECOND item live, without republishing — the whole point of the
// draft/publish split is that this should NOT be visible to shoppers yet.
await placeCatalogItem('Brick', 250, 420);

const { landlets } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.ownerBuilderId && l.activeVersionId);
const { instances: liveInstances } = await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`);
const { version: publishedVersion } = await fetchJson(`/api/landlets/${myLandlet.landletId}/versions/${myLandlet.activeVersionId}`);
console.log('live draft instance count after 2nd placement (should be 2):', liveInstances.length);
console.log('published snapshot instance count (should still be 1, frozen at publish time):', publishedVersion.instances.length);
const publishedSnapshotUnaffected = publishedVersion.instances.length === 1 && publishedVersion.instances[0].templateId === 'placeholder-tree';

// Publish again — now both items become "live," and the first version
// should show as no longer live with Set Live re-enabled on it.
await page.click('#settings-btn');
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForTimeout(500);
await page.click('.version-action-btn:has-text("Publish")');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 2, { timeout: 10000 });
const rowCountAfterSecondPublish = await page.locator('.version-row').count();
console.log('version rows after second publish (should be 2):', rowCountAfterSecondPublish);

const { landlets: landletsAfterSecondPublish } = await fetchJson('/api/landlets?limit=100');
const activeVersionIdAfterSecondPublish = landletsAfterSecondPublish.find((l) => l.landletId === myLandlet.landletId).activeVersionId;

// Set Live on the OLDER (Tree-only) version — should repoint activeVersionId
// without touching the live draft (still 2 items).
const olderRow = page.locator('.version-row').last(); // oldest listed last (newest-first)
const olderRowSetLiveEnabled = await olderRow.locator('button', { hasText: 'Set Live' }).isEnabled();
await olderRow.locator('button', { hasText: 'Set Live' }).click();
await page.waitForFunction(
  () => document.getElementById('build-publish-status')?.textContent.includes('now see'),
  { timeout: 10000 },
);
const { landlets: landletsAfterSetLive } = await fetchJson('/api/landlets?limit=100');
const landletAfterSetLive = landletsAfterSetLive.find((l) => l.landletId === myLandlet.landletId);
const { instances: liveInstancesAfterSetLive } = await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`);
console.log('older version Set Live was enabled (should be true):', olderRowSetLiveEnabled);
console.log('activeVersionId changed after Set Live (should differ from right after the 2nd publish):', landletAfterSetLive.activeVersionId !== activeVersionIdAfterSecondPublish ? 'changed' : 'unchanged');
console.log('live draft still has 2 items after Set Live (editor untouched, should be 2):', liveInstancesAfterSetLive.length);

// Restore to Editor on that same older (Tree-only) version — this SHOULD
// replace the live draft, unlike Set Live.
await page.click('.settings-tab-btn[data-section="build"]'); // re-render after the reload-triggering click below is safer against a stale row
await page.waitForTimeout(300);
const treeOnlyRow = page.locator('.version-row').filter({ hasText: '1 item' }).last();
await treeOnlyRow.locator('button', { hasText: 'Restore to Editor' }).click();
await page.waitForFunction(() => !document.getElementById('claim-modal')?.classList.contains('visible'), { timeout: 15000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 15000 });
await page.waitForTimeout(1500);

// A restore reloads the page with Build as the start mode (see
// START_MODE_KEY), so bootstrap() opens the identity picker directly on
// load — unlike a bare reload (defaults to Shop), there's no separate nav
// click needed, and clicking the Build tab here would be a no-op blocked
// by the already-open picker (it's already the active mode).
await page.waitForSelector('#identity-modal.visible', { timeout: 10000 });
const reentryRow = page.locator('.identity-row').filter({ hasText: LABEL });
await reentryRow.locator('.identity-row-toggle').last().click();
await page.waitForTimeout(300);
await reentryRow.locator('button', { hasText: 'Build' }).last().click();
await page.waitForSelector('#identity-btn', { timeout: 10000 });
await page.waitForTimeout(1500);

const { instances: instancesAfterRestore } = await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`);
console.log('live draft instance count after Restore to Editor (should be back to 1):', instancesAfterRestore.length);
const restoredCorrectly = instancesAfterRestore.length === 1 && instancesAfterRestore[0].templateId === 'placeholder-tree';

const { versions: versionsAfterRestore } = await fetchJson(`/api/landlets/${myLandlet.landletId}/versions?limit=20`);
console.log('a 3rd version was auto-created by the restore itself (should be >= 3):', versionsAfterRestore.length);

const pass = historyAfterFirstPublish === 1 &&
  firstRowText.includes('1 item') && firstRowText.includes('live') &&
  setLiveDisabledOnLiveRow &&
  publishedSnapshotUnaffected &&
  rowCountAfterSecondPublish === 2 &&
  olderRowSetLiveEnabled &&
  landletAfterSetLive.activeVersionId !== activeVersionIdAfterSecondPublish &&
  liveInstancesAfterSetLive.length === 2 &&
  restoredCorrectly &&
  versionsAfterRestore.length >= 3 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Publish + Version History (Set Live vs Restore to Editor)', errors });
