// #1062 (client half) / #3101: a Build tab that saves an item another tab has
// since changed must not silently overwrite it. The server refuses a stale
// write (expectedUpdatedAt); the stale tab then shows the other tab's version
// and tells the builder in plain words. This drives:
//   0. a tab's own back-to-back saves never read as a conflict (it adopts the
//      version every save returns);
//   1. batch save (group move / Undo/Redo path): the other tab's edit survives,
//      the stale tab ends up showing it, and is told;
//   2. single-item save (a one-item drag): same, via the 409 recovery;
//   3. after either resolution the tab's next save goes through.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Stale Save Two Tabs Builder';
const { browser, page: tabA, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(tabA, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(tabA);
await tabA.reload();
await chooseIdentity(tabA, { mode: 'build', label: LABEL, isNew: true });
await tabA.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await tabA.waitForTimeout(1500);

const dialogsA = [];
tabA.on('dialog', (dialog) => dialogsA.push(dialog.message()));

async function pageFetchJson(page, pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}

async function placeTree(page, x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1200);
}

const sceneIds = (page) => page.evaluate(() => window.__testProductScreenPositions().map((p) => p.instanceId));
const localX = (page, id) => page.evaluate((i) => {
  const raw = JSON.parse(localStorage.getItem('higglehaven.landlet.instances') || '[]');
  return raw.find((inst) => inst.id === i)?.x ?? null;
}, id);
const serverInstance = async (id) => (await pageFetchJson(tabA, `/api/instances/${encodeURIComponent(id)}`)).body.instance;

await placeTree(tabA, 260, 520);
const [itemX] = await sceneIds(tabA);
console.log('tab A placed an item:', Boolean(itemX));

// --- 0. Own back-to-back saves don't conflict with themselves. ---
await tabA.evaluate((id) => window.__testSyncBatchUpdate([id]), itemX);
await tabA.evaluate((id) => window.__testSyncUpdate(id), itemX);
await tabA.evaluate((id) => window.__testSyncBatchUpdate([id]), itemX);
await tabA.waitForTimeout(500);
const noSelfConflict = dialogsA.length === 0;
console.log('no conflict notice from tab A\'s own repeated saves (should be true):', noSelfConflict);

// --- Tab B: a second tab in the same session. ---
const contextB = await browser.newContext({ viewport: { width: 420, height: 860 } });
await contextB.addCookies(await tabA.context().cookies());
const tabB = await contextB.newPage();
tabB.on('pageerror', (err) => errors.push(err.message));
tabB.on('dialog', (dialog) => dialog.accept());
await tabB.goto(process.env.E2E_BASE_URL || 'http://127.0.0.1:8787', { waitUntil: 'networkidle' });
await chooseIdentity(tabB, { mode: 'build', label: LABEL, isNew: true });
await tabB.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await tabB.waitForTimeout(1500);

const start = await serverInstance(itemX);
const moveElsewhere = async (dx) => {
  const current = await serverInstance(itemX);
  const res = await pageFetchJson(tabB, `/api/instances/${encodeURIComponent(itemX)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: current.x + dx }),
  });
  return res.body.instance;
};

// --- 1. Batch save from the stale tab. ---
const afterB1 = await moveElsewhere(1);
const aStillShowsOld = Math.abs((await localX(tabA, itemX)) - start.x) < 1e-3;
dialogsA.length = 0;
await tabA.evaluate((id) => window.__testSyncBatchUpdate([id]), itemX);
await tabA.waitForTimeout(1500);
const serverAfterBatch = await serverInstance(itemX);
const batchKeptOther = Math.abs(serverAfterBatch.x - afterB1.x) < 1e-3;
const aNowShowsOther = Math.abs((await localX(tabA, itemX)) - afterB1.x) < 1e-3;
const batchNotice = dialogsA.some((m) => /changed in another tab or window/.test(m) && /latest version/.test(m));
console.log('tab A still showed its old position before saving (should be true):', aStillShowsOld);
console.log('server kept tab B\'s move after A\'s stale batch save (should be true):', batchKeptOther);
console.log('tab A now shows tab B\'s version (should be true):', aNowShowsOther);
console.log('tab A was told, in words (should be true):', batchNotice);

// --- 3a. A's next save after the batch resolution goes through (version adopted). ---
dialogsA.length = 0;
await tabA.evaluate((id) => window.__testSyncBatchUpdate([id]), itemX);
await tabA.waitForTimeout(800);
const nextBatchClean = dialogsA.length === 0;
console.log('tab A\'s next batch save raises no conflict (should be true):', nextBatchClean);

// --- 2. Single-item save from the stale tab. ---
const afterB2 = await moveElsewhere(1);
dialogsA.length = 0;
await tabA.evaluate((id) => window.__testSyncUpdate(id), itemX);
await tabA.waitForTimeout(2000);
const serverAfterSingle = await serverInstance(itemX);
const singleKeptOther = Math.abs(serverAfterSingle.x - afterB2.x) < 1e-3;
const aShowsOtherAfterSingle = Math.abs((await localX(tabA, itemX)) - afterB2.x) < 1e-3;
const singleNotice = dialogsA.some((m) => /changed somewhere else/.test(m) && /put back the way it is saved/.test(m));
console.log('server kept tab B\'s move after A\'s stale single save (should be true):', singleKeptOther);
console.log('tab A shows tab B\'s version after the single-save conflict (should be true):', aShowsOtherAfterSingle);
console.log('tab A was told, in words (should be true):', singleNotice);

// --- 3b. And its next single save goes through. ---
dialogsA.length = 0;
await tabA.evaluate((id) => window.__testSyncUpdate(id), itemX);
await tabA.waitForTimeout(1000);
const nextSingleClean = dialogsA.length === 0;
console.log('tab A\'s next single save raises no conflict (should be true):', nextSingleClean);

await finish(browser, {
  pass: noSelfConflict && aStillShowsOld && batchKeptOther && aNowShowsOther && batchNotice && nextBatchClean
    && singleKeptOther && aShowsOtherAfterSingle && singleNotice && nextSingleClean,
  label: 'build-stale-save-two-tabs.test.mjs',
  errors,
});
