// #636 (last sub-issue of #631): pasting selected saved-layout instances
// back onto a real, owned landlet — the one piece #634/#635's own e2e
// coverage (saved-layout-preview.test.mjs) deliberately left untested,
// since neither of those sub-issues actually applied a selection anywhere.
// Reuses that same test's setup shape (level-add/place/level-remove over
// the real HTTP API to get a genuine saved-layout row), then re-adds a
// level on the SAME landlet before pasting — a builder who's since grown
// enough land cap to re-purchase the level they once removed is exactly
// the real story this feature exists for.
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
const instanceId = 'saved-layout-paste-suite-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId, templateId: 'placeholder-tree', x: 4, y: 5, z: LEVEL_HEIGHT_M * 1.5 }),
});
const levelRemoved = await fetchJson(`/api/landlets/${landletId}/levels/1`, { method: 'DELETE' });
console.log('level remove status (should be 200):', levelRemoved.status);

// Re-add the level on the SAME landlet so a paste back onto it has
// somewhere to land — the target picker defaults to (and, with only one
// owned landlet, is the only option) exactly this landlet.
const levelReadded = await fetchJson(`/api/landlets/${landletId}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});
console.log('level re-add status (should be 201):', levelReadded.status);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, { timeout: 10000 });

const savedLayoutRow = page.locator('.settings-field', { hasText: 'Saved Layouts' }).locator('.version-row');
await savedLayoutRow.locator('button', { hasText: 'Preview' }).click();
await page.waitForFunction(() => document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), { timeout: 15000 });
await page.waitForTimeout(1000); // let the model actually load/render before interacting with it

// Marquee-select the whole visible canvas, same coordinate-agnostic
// approach as the preview suite.
await page.mouse.move(10, 10);
await page.mouse.down();
await page.mouse.move(410, 850, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const selectionAfterDrag = await page.locator('#layout-preview-selection-count').textContent();
console.log('selection count after marquee-drag (should be "1 selected"):', selectionAfterDrag);

const pasteBtnVisible = await page.locator('#layout-preview-paste-btn').isVisible();
console.log('paste button visible once something is selected (should be true):', pasteBtnVisible);

await page.click('#layout-preview-paste-btn');
await page.waitForFunction(
  () => document.getElementById('layout-preview-paste-status')?.textContent.includes('Pasted'),
  { timeout: 10000 },
);
const pasteStatus = await page.locator('#layout-preview-paste-status').textContent();
console.log('paste status text (should mention Pasted 1):', pasteStatus);

// Selection clears back out once the paste succeeds.
const selectionAfterPaste = await page.locator('#layout-preview-selection-count').textContent();
console.log('selection count after a successful paste (should be empty):', JSON.stringify(selectionAfterPaste));

const afterPaste = await fetchJson(`/api/instances?landletId=${landletId}`);
const pastedInstance = afterPaste.body.instances.find((i) => i.instanceId !== instanceId && i.x === 4 && i.y === 5);
console.log('a fresh instance landed back on the target landlet at the original x/y (should be truthy):', Boolean(pastedInstance));

// The saved layout itself is untouched by pasting — still fetchable with
// its original snapshot, matching the worker-level unit test's own
// assertion for this endpoint.
const savedLayoutsStill = (await fetchJson('/api/builders/me/saved-layouts')).body.savedLayouts;
console.log('saved layout still present after pasting (should be 1):', savedLayoutsStill.length);

const pass = levelRemoved.status === 200 &&
  levelReadded.status === 201 &&
  selectionAfterDrag.includes('1 selected') &&
  pasteBtnVisible === true &&
  pasteStatus.includes('Pasted 1') &&
  selectionAfterPaste.trim() === '' &&
  Boolean(pastedInstance) &&
  pastedInstance.instanceId !== instanceId &&
  savedLayoutsStill.length === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Saved-layout paste applies a selection onto a real landlet (#636)', errors });
