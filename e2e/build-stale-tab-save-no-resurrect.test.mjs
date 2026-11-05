// #3101 (option 2): a Build tab that stays focused never gets a refocus
// reconcile, so when another tab deletes an item, this tab's next save of
// that item (a group move or Undo/Redo -- both go through PUT
// /api/instances/batch) used to recreate it server-side. The tab now saves
// with updateOnly: the server skips ids it no longer has, and the tab drops
// them and says so, without losing the save of its other items.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Stale Tab Save Suite Builder';

const { browser, page: tabA, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(tabA, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(tabA);
await tabA.reload();
await chooseIdentity(tabA, { mode: 'build', label: LABEL, isNew: true });
await tabA.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await tabA.waitForTimeout(1500);

async function pageFetchJson(page, pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}

const { body: buildersBody } = await pageFetchJson(tabA, '/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(tabA, `/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landletId = landletsBody.landlets[0].landletId;

const sceneIds = (page) => page.evaluate(() => window.__testProductScreenPositions().map((p) => p.instanceId));
async function serverIds() {
  const { body } = await pageFetchJson(tabA, `/api/instances?landletId=${encodeURIComponent(landletId)}&limit=100`);
  return body.instances.map((i) => i.instanceId);
}

async function placeTree(page, x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}


// --- Setup: tab A places two items (X then Y). ---
await placeTree(tabA, 260, 520);
await placeTree(tabA, 160, 560);
const [itemX, itemY] = await sceneIds(tabA);
console.log('tab A scene after placing two items (should be 2):', (await sceneIds(tabA)).length);

// --- Tab B: same session, in Build mode, deletes X. ---
const contextB = await browser.newContext({ viewport: { width: 420, height: 860 } });
await contextB.addCookies(await tabA.context().cookies());
const tabB = await contextB.newPage();
tabB.on('pageerror', (err) => errors.push(err.message));
tabB.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
tabB.on('dialog', (dialog) => dialog.accept());
await tabB.goto(process.env.E2E_BASE_URL || 'http://127.0.0.1:8787', { waitUntil: 'networkidle' });
await chooseIdentity(tabB, { mode: 'build', label: LABEL, isNew: true });
await tabB.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await tabB.waitForTimeout(2000);
const del = await pageFetchJson(tabB, `/api/instances/${encodeURIComponent(itemX)}`, { method: 'DELETE' });
console.log('tab B deleted item X (should be 200):', del.status);

// Tab A never refocused: it still shows X, and saves both items.
await tabA.evaluate(() => { window.__alerts = []; window.alert = (msg) => { window.__alerts.push(String(msg)); }; });
const sceneBefore = await sceneIds(tabA);
console.log('tab A still shows both items before saving (should be 2):', sceneBefore.length);
await tabA.evaluate((ids) => window.__testSyncBatchUpdate(ids), [itemX, itemY]);
await tabA.waitForTimeout(1500);

const serverAfter = await serverIds();
const sceneAfter = await sceneIds(tabA);
const alerts = await tabA.evaluate(() => window.__alerts);
console.log('server has X after tab A saved (should be false):', serverAfter.includes(itemX));
console.log('server still has Y (should be true):', serverAfter.includes(itemY));
console.log('tab A scene after saving (should be just Y):', JSON.stringify(sceneAfter));
console.log('alerts:', JSON.stringify(alerts));

await tabB.close();
const pass = sceneBefore.length === 2
  && del.status === 200
  && !serverAfter.includes(itemX)
  && serverAfter.includes(itemY)
  && sceneAfter.length === 1 && sceneAfter[0] === itemY
  && alerts.length === 1 && /another tab or window/.test(alerts[0])
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3101: a stale Build tab saving an item deleted in another tab does not recreate it',
  errors,
});
