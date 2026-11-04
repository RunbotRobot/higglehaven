// #3101 (found walking #3083): two Build mode tabs on one landlet drift apart.
// A stale tab never learns another tab deleted an item, and its next Undo/Redo
// re-saves every mesh in the snapshot through PUT /api/instances/batch, which
// creates any stored id that is missing -- silently recreating the item the
// other tab deleted. (A single-item move/rotate uses PATCH, a 404 on a deleted
// item, so it can't resurrect; Undo/Redo and group moves are the real paths.)
//
// The fix: when a Build tab becomes visible again and nothing local is unsaved
// or in flight, refetch the landlet's instances and reconcile the scene, no
// polling. This drives:
//   1. tab B deletes an item, tab A (stale) regains focus, A's scene drops it,
//      and A's next Undo cannot recreate it server-side;
//   2. a save still in flight when the tab regains focus is never clobbered;
//   3. an edit whose save failed is never silently reverted.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Two Tabs Reconcile Suite Builder';

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

// The reconcile throttles back-to-back triggers (visibilitychange and focus
// fire together on a real tab switch), so a test that triggers it twice waits
// out the throttle in between.
const THROTTLE_WAIT_MS = 1200;
async function regainFocus(page) {
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(2000);
}

// --- Setup: tab A places two items (X then Y). ---
await placeTree(tabA, 260, 520);
await placeTree(tabA, 160, 560);
const idsA = await sceneIds(tabA);
const [itemX, itemY] = idsA;
console.log('tab A scene after placing two items (should be 2):', idsA.length);

// --- Tab B: a second tab in the same session, also in Build mode. ---
// (launchPage's own context can't open a sibling page, so tab B gets a second
// context carrying the same session cookie -- the same account, as far as the
// server can tell.)
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
const idsB = await sceneIds(tabB);
console.log('tab B sees both items on load (should be 2):', idsB.length);

// Tab B deletes X (through the API: what matters here is the server state B leaves behind).
const del = await pageFetchJson(tabB, `/api/instances/${encodeURIComponent(itemX)}`, { method: 'DELETE' });
console.log('tab B deleted item X (should be 200):', del.status);

// --- 1. Tab A (stale) regains focus: its scene drops X, and Undo can't resurrect it. ---
await regainFocus(tabA);
const sceneAfterFocus = await sceneIds(tabA);
console.log('tab A scene after regaining focus (should be just Y):', JSON.stringify(sceneAfterFocus));
const undoEnabled = await tabA.locator('#undo-btn').isEnabled();
if (undoEnabled) {
  await tabA.click('#undo-btn');
  await tabA.waitForTimeout(1500);
}
const serverAfterUndo = await serverIds();
console.log('server has X after tab A\'s Undo (should be false):', serverAfterUndo.includes(itemX));
const staleTabReconciled = sceneAfterFocus.length === 1 && sceneAfterFocus[0] === itemY && !serverAfterUndo.includes(itemX);

// --- 2. A save still in flight when the tab regains focus is not clobbered. ---
await tabA.waitForTimeout(THROTTLE_WAIT_MS);
let releasePost;
const held = new Promise((resolve) => { releasePost = resolve; });
await tabA.route('**/api/instances', async (route) => {
  if (route.request().method() === 'POST') await held;
  await route.continue();
});
const beforeZ = await sceneIds(tabA);
await placeTree(tabA, 300, 600);
const afterZ = await sceneIds(tabA);
const itemZ = afterZ.find((id) => !beforeZ.includes(id));
await regainFocus(tabA);
const zKeptWhileInFlight = (await sceneIds(tabA)).includes(itemZ);
console.log('in-flight item Z still in the scene after refocus (should be true):', zKeptWhileInFlight);
releasePost();
await tabA.waitForTimeout(1500);
await tabA.unroute('**/api/instances');
const zSaved = (await serverIds()).includes(itemZ);
console.log('item Z reached the server once released (should be true):', zSaved);

// --- 3. An edit whose save failed is not silently reverted. ---
await tabA.waitForTimeout(THROTTLE_WAIT_MS);
await tabA.route('**/api/instances', async (route) => {
  if (route.request().method() === 'POST') {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'forced failure' }) });
    return;
  }
  await route.continue();
});
const beforeW = await sceneIds(tabA);
await placeTree(tabA, 200, 640);
const itemW = (await sceneIds(tabA)).find((id) => !beforeW.includes(id));
await regainFocus(tabA);
const wKeptAfterFailure = (await sceneIds(tabA)).includes(itemW);
console.log('item W (failed save) still in the scene after refocus (should be true):', wKeptAfterFailure);
await tabA.unroute('**/api/instances');

await tabB.close();

const pass = idsA.length === 2
  && idsB.length === 2
  && del.status === 200
  && staleTabReconciled
  && zKeptWhileInFlight
  && zSaved
  && wKeptAfterFailure
  // The forced 500 is the only expected browser-logged failure.
  && errors.every((e) => /status of 500/.test(e));
await finish(browser, {
  pass,
  label: '#3101: a refocused Build tab reconciles with another tab\'s edits without clobbering its own unsaved work',
  errors,
});
