// #636 (sub-issue of #631): pastes a saved layout's selected instances onto
// the builder's own landlet as brand-new placed_instances rows, from
// inside #635's faux-layout preview. Setup mirrors
// saved-layout-preview.test.mjs's own real level-add/place/level-remove
// flow to get a real saved-layout row; this test's own point is the paste
// itself — both that it actually creates new instances with fresh ids on
// success, and that a target landlet without the space the saved z needs
// gets the exact same rejection a normal instance-create would (not
// treated as "already paid for" just because the instance existed once).
import {
  launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, grantLandCapHeadroomAsAdmin,
} from './helpers.mjs';

const LABEL = 'Saved Layout Paste Suite Tester';
const LEVEL_HEIGHT_M = 10;

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

await fetchJson(`/api/landlets/${landletId}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});
const sourceInstanceId = 'saved-layout-paste-suite-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: sourceInstanceId, landletId, templateId: 'placeholder-tree', x: 2, y: 3, z: LEVEL_HEIGHT_M * 1.5 }),
});
const levelRemoved = await fetchJson(`/api/landlets/${landletId}/levels/1`, { method: 'DELETE' });
console.log('level remove status, creating the saved layout (should be 200):', levelRemoved.status);

// The landlet has no level 1 right now (just removed) — pasting the saved
// instance's z=15 back "for free" without re-purchasing that level must be
// rejected exactly like a normal out-of-bounds instance-create would be,
// not silently allowed because the instance already existed once.
const rejectedBeforeRepurchase = await fetchJson('/api/instances/batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instances: [{ landletId, templateId: 'placeholder-tree', x: 2, y: 3, z: LEVEL_HEIGHT_M * 1.5 }] }),
});
console.log('paste-equivalent create rejected pre-repurchase (should be 400):', rejectedBeforeRepurchase.status);

// Re-purchase level 1 so the landlet's own z-bounds cover the saved z
// again, then actually exercise the UI: Settings > Saved Layouts >
// Preview > marquee-select > Paste onto Land.
await fetchJson(`/api/landlets/${landletId}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, { timeout: 10000 });
const savedLayoutRow = page.locator('.settings-field', { hasText: 'Saved Layouts' }).locator('.version-row');
await savedLayoutRow.locator('button', { hasText: 'Preview' }).click();
await page.waitForFunction(() => document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), { timeout: 15000 });
await page.waitForTimeout(1000); // let the model actually load/render before interacting with it

const pasteBtnHiddenBeforeSelection = await page.locator('#layout-preview-paste-btn').isHidden();
console.log('paste button hidden before any selection (should be true):', pasteBtnHiddenBeforeSelection);

await page.mouse.move(10, 10);
await page.mouse.down();
await page.mouse.move(410, 850, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const selectionAfterDrag = await page.locator('#layout-preview-selection-count').textContent();
console.log('selection count after marquee-drag (should be "1 selected"):', selectionAfterDrag);
const pasteBtnVisibleAfterSelection = await page.locator('#layout-preview-paste-btn').isVisible();
console.log('paste button visible once something is selected (should be true):', pasteBtnVisibleAfterSelection);

await page.click('#layout-preview-paste-btn');
await page.waitForFunction(() => !document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), { timeout: 15000 });
await page.waitForSelector('#add-item-btn', { timeout: 10000 });
console.log('back in Build mode after pasting (add-item-btn visible): ok');

const { instances: instancesAfterPaste } = (await fetchJson(`/api/instances?landletId=${landletId}&limit=100`)).body;
console.log('instances on the landlet after paste (should be 1 — the freshly pasted one):', instancesAfterPaste.length);
const pasted = instancesAfterPaste[0];
const pastedMatchesSource = pasted &&
  pasted.instanceId !== sourceInstanceId &&
  pasted.templateId === 'placeholder-tree' &&
  pasted.x === 2 && pasted.y === 3 && pasted.z === LEVEL_HEIGHT_M * 1.5;
console.log('pasted instance is a fresh copy at the same position (should be true):', pastedMatchesSource);

const savedLayoutsAfterPaste = (await fetchJson('/api/builders/me/saved-layouts')).body.savedLayouts;
console.log('saved layout still exists after paste, i.e. paste copies rather than moves (should be 1):', savedLayoutsAfterPaste.length);

// The deliberate 400 above is a real, expected HTTP error response —
// Chromium logs it to the console as "Failed to load resource" independent
// of anything this app's own code does, the same expected fallout
// didit-verification.test.mjs's own comment documents filtering out.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = levelRemoved.status === 200 &&
  rejectedBeforeRepurchase.status === 400 &&
  pasteBtnHiddenBeforeSelection &&
  selectionAfterDrag.includes('1 selected') &&
  pasteBtnVisibleAfterSelection &&
  instancesAfterPaste.length === 1 &&
  pastedMatchesSource &&
  savedLayoutsAfterPaste.length === 1 &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Paste saved-layout instances onto my lándlet, with the same z-bounds check a normal create gets (#636)', errors });
