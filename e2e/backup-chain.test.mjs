// Build-mode backup chain UI (#2051, a sub-issue of #1952/#1947's tracking
// issue) — the per-instance "if this item sells out, the next one in this
// list takes its place" configuration panel, backed by the
// placed_instance_backups API covered in worker/placed-instance-backups.test.js
// and documented in docs/API.md's "Placed instance backup chains (#2050)".
// This covers the actual UI wiring that test suite can't: the toolbar
// button's selection-gated enable/disable, opening/closing the
// #backup-chain-modal panel, adding a backup via the shared catalog picker
// (reused in "pick mode" rather than its normal placement mode — see
// openCatalogPickerForPick's own comment in src/main.js), the low-opacity
// placement reference mesh shown while picking (exposed for this test via
// window.__testBackupReferenceMeshVisible, same window.__test* convention as
// window.__testShopAvatarHasTransparentMaterial), reordering via the ▲/▼
// row buttons, removing a row, and a plain cancel (closing the picker
// without picking) correctly reopening the backup-chain panel rather than
// leaving both modals' state stuck.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Backup Chain Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Place a chair and select it (placement auto-selects, per
// handlePlacementClick) -- this is the instance we'll configure a backup
// chain for.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Chair' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const backupChainBtn = () => page.locator('#toggle-backup-chain');

// Same selection-gated pattern as Community Sign/Calendar's own buttons
// (updateSelectionUI's `backupChainBtn.disabled = !singleMesh` — note the
// whole #gizmo-mode-controls row, this button included, is only ever
// *shown* with something selected in the first place, per its own
// `.visible` toggle, so there's no observably-disabled-but-visible state
// for the empty-selection case to check here; disabled-but-visible only
// happens for a multi-item selection, not covered by this test).
await page.waitForTimeout(300);
const enabledWhenSelected = await backupChainBtn().isDisabled();
console.log('Backup Chain button disabled with exactly the chair selected (should be false):', enabledWhenSelected);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const chairInstance = instances.find((i) => i.templateId === 'placeholder-chair');

await backupChainBtn().click();
await page.waitForSelector('#backup-chain-modal.visible', { timeout: 5000 });
const emptyStateShown = await page.locator('#backup-chain-empty').isVisible();
console.log('"No backups configured yet" shown before adding any (should be true):', emptyStateShown);

// "+ Add Backup" closes this panel (only one modal is ever tracked active
// at a time -- see openModalA11y's own comment in src/main.js) and opens the
// shared catalog picker in "pick" mode: Products-only, scope tabs hidden,
// and the low-opacity reference mesh of the chair itself shown behind it.
await page.click('#backup-chain-add-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 5000 });
const backupModalHiddenWhilePicking = await page.locator('#backup-chain-modal.visible').count();
const scopeTabsHiddenWhilePicking = await page.locator('#catalog-search-scope-tabs').isHidden();
const productsScopeForced = await page.locator('.search-scope-btn[data-search-scope="products"]').evaluate((el) => el.classList.contains('active'));
const referenceMeshShown = await page.evaluate(() => window.__testBackupReferenceMeshVisible());
console.log('#backup-chain-modal no longer .visible while the picker is open (should be 0):', backupModalHiddenWhilePicking);
console.log('scope tabs hidden during a backup pick (should be true):', scopeTabsHiddenWhilePicking);
console.log('Products scope forced active during a backup pick (should be true):', productsScopeForced);
console.log('low-opacity placement reference mesh shown while picking (should be true):', referenceMeshShown);

// Pick the tree as the first backup.
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForSelector('#backup-chain-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const referenceMeshHiddenAfterPick = await page.evaluate(() => window.__testBackupReferenceMeshVisible());
const rowsAfterFirstAdd = await page.locator('.backup-chain-row').count();
const firstRowText = await page.locator('.backup-chain-row').first().textContent();
console.log('reference mesh hidden again once a pick completes (should be false):', referenceMeshHiddenAfterPick);
console.log('rows shown after adding one backup (should be 1):', rowsAfterFirstAdd);
console.log('first row names the picked product (should mention "Tree"):', firstRowText);

const { backups: backupsAfterFirstAdd } = (await fetchJson(`/api/instances/${chairInstance.instanceId}/backups`)).body;
console.log('backend chain after the first add (should be 1 entry, placeholder-tree):', backupsAfterFirstAdd.map((b) => b.templateId));

// Add a second backup (the table) -- exercises the close-then-reopen flow
// a second time from an already-populated (not empty) chain.
await page.click('#backup-chain-add-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 5000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Table' }).click();
await page.waitForSelector('#backup-chain-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const rowsAfterSecondAdd = await page.locator('.backup-chain-row').count();
console.log('rows shown after adding a second backup (should be 2):', rowsAfterSecondAdd);

// Reorder: move the second row (table) up to first place via its own ▲
// button -- the real moderation path, not the API directly.
await page.locator('.backup-chain-row').filter({ hasText: 'Table' }).locator('.backup-chain-row-up').click();
await page.waitForFunction(() => {
  const first = document.querySelector('.backup-chain-row');
  return first && first.textContent.includes('Table');
}, { timeout: 5000 });
const firstRowAfterReorder = await page.locator('.backup-chain-row').first().textContent();
console.log('first row after moving table up (should now mention "Table"):', firstRowAfterReorder);

const { backups: backupsAfterReorder } = (await fetchJson(`/api/instances/${chairInstance.instanceId}/backups`)).body;
console.log('backend chain order after reordering (should be [placeholder-table, placeholder-tree]):', backupsAfterReorder.map((b) => b.templateId));

// Remove the tree (now second) via its row's own × button.
await page.locator('.backup-chain-row').filter({ hasText: 'Tree' }).locator('.backup-chain-row-remove').click();
await page.waitForFunction(() => document.querySelectorAll('.backup-chain-row').length === 1, { timeout: 5000 });
const rowsAfterRemove = await page.locator('.backup-chain-row').count();
console.log('rows shown after removing one via the panel (should be 1):', rowsAfterRemove);

const { backups: backupsAfterRemove } = (await fetchJson(`/api/instances/${chairInstance.instanceId}/backups`)).body;
console.log('backend chain after the panel remove (should be 1 entry, placeholder-table):', backupsAfterRemove.map((b) => b.templateId));

// Plain cancel: open the picker again, then close it (the × button) without
// picking anything -- should reopen the backup-chain panel via onDone
// rather than leaving the picker's own "pick mode" state stuck, and should
// not add a third entry.
await page.click('#backup-chain-add-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 5000 });
await page.click('#catalog-picker-close-btn');
await page.waitForSelector('#backup-chain-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const rowsAfterCancel = await page.locator('.backup-chain-row').count();
const referenceMeshHiddenAfterCancel = await page.evaluate(() => window.__testBackupReferenceMeshVisible());
console.log('#backup-chain-modal reopened after a plain cancel (should be visible already, implicit in the wait above)');
console.log('rows unchanged after cancelling an add (should still be 1):', rowsAfterCancel);
console.log('reference mesh hidden after cancelling (should be false):', referenceMeshHiddenAfterCancel);

await page.click('#backup-chain-close-btn');
await page.waitForSelector('#backup-chain-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const modalHiddenAfterClose = await page.locator('#backup-chain-modal').evaluate((el) => !el.classList.contains('visible'));
console.log('#backup-chain-modal closed via its own close button (should be true):', modalHiddenAfterClose);

const pass = enabledWhenSelected === false &&
  emptyStateShown === true &&
  backupModalHiddenWhilePicking === 0 &&
  scopeTabsHiddenWhilePicking === true &&
  productsScopeForced === true &&
  referenceMeshShown === true &&
  referenceMeshHiddenAfterPick === false &&
  rowsAfterFirstAdd === 1 &&
  firstRowText.includes('Tree') &&
  backupsAfterFirstAdd.length === 1 && backupsAfterFirstAdd[0].templateId === 'placeholder-tree' &&
  rowsAfterSecondAdd === 2 &&
  firstRowAfterReorder.includes('Table') &&
  backupsAfterReorder.length === 2 &&
  backupsAfterReorder[0].templateId === 'placeholder-table' &&
  backupsAfterReorder[1].templateId === 'placeholder-tree' &&
  rowsAfterRemove === 1 &&
  backupsAfterRemove.length === 1 && backupsAfterRemove[0].templateId === 'placeholder-table' &&
  rowsAfterCancel === 1 &&
  referenceMeshHiddenAfterCancel === false &&
  modalHiddenAfterClose === true &&
  errors.length === 0;
await finish(browser, { pass, label: 'Build-mode backup chain panel + catalog-picker reuse + reference mesh + backup API', errors });
