// #4403: a bundle is saved in chunks of 100. If the server refuses a later chunk (here: outside_landlet_outline),
// the earlier chunks had already stored the new poses, and Build "put things back" by reading the server, which left
// the bundle half moved and saved that way. Now every member is put back to where the gesture began and saved, so
// the server holds the old poses for all of them, and the screen agrees.
import { launchPage, chooseIdentity, claimLandlet, captureNotices, finish } from './helpers.mjs';

const LABEL = 'Bundle All Or Nothing Builder';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const pageJson = (path, options) => page.evaluate(async ([p, opts]) => {
  const res = await fetch(p, opts);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}, [path, options]);

const landletId = (await pageJson('/api/landlets?status=claimed&ownerBuilderId=me&limit=1')).body.landlets[0].landletId;
const COUNT = 150;
const seeded = Array.from({ length: COUNT }, (_, i) => ({
  instanceId: `allornothing-${i}`, landletId, templateId: 'placeholder-tree',
  x: -6 + (i % 15) * 0.8, y: -4 + Math.floor(i / 15) * 0.8, z: 0,
}));
for (let i = 0; i < COUNT; i += 100) {
  const stored = await pageJson('/api/instances/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instances: seeded.slice(i, i + 100) }) });
  if (stored.status !== 201 && stored.status !== 200) throw new Error(`seeding failed: ${stored.status} ${JSON.stringify(stored.body).slice(0, 200)}`);
}

// Back into Build with the seeded items loaded.
await page.reload();
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 20000 });
await page.waitForFunction((n) => Object.keys(window.__testInstancePositions?.() ?? {}).length >= n, COUNT, { timeout: 60000 });
await captureNotices(page);

const ids = seeded.map((s) => s.instanceId);
const before = await page.evaluate(() => window.__testInstancePositions());

// The server stores the first chunk of the move and refuses the second.
let putCalls = 0;
await page.route('**/api/instances/batch', async (route) => {
  if (route.request().method() !== 'PUT') { await route.continue(); return; }
  putCalls += 1;
  const body = JSON.parse(route.request().postData() ?? '{}');
  const movedBack = (body.instances ?? []).some((inst) => inst.instanceId?.startsWith('allornothing-') && Math.abs(inst.x - seeded.find((s) => s.instanceId === inst.instanceId).x) < 1e-9);
  if (putCalls === 2 && !movedBack) {
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Instance extends outside the lándlet\'s outline', code: 'outside_landlet_outline' }) });
    return;
  }
  await route.continue();
});

await page.evaluate(([list, dx]) => window.__testMoveAndSyncBatch(list, dx), [ids, 0.5]);
await page.waitForFunction(() => window.__alerts.length > 0, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.unroute('**/api/instances/batch');

const after = await page.evaluate(() => window.__testInstancePositions());
const sameOnScreen = ids.every((id) => Math.abs(after[id][0] - before[id][0]) < 1e-6);
const serverList = (await pageJson(`/api/instances?landletId=${encodeURIComponent(landletId)}&limit=100`)).body;
const serverAll = [...serverList.instances];
let cursor = serverList.nextCursor;
while (cursor) {
  const next = (await pageJson(`/api/instances?landletId=${encodeURIComponent(landletId)}&limit=100&cursor=${encodeURIComponent(cursor)}`)).body;
  serverAll.push(...next.instances);
  cursor = next.nextCursor;
}
const serverById = new Map(serverAll.map((inst) => [inst.instanceId, inst]));
const sameOnServer = seeded.every((s) => Math.abs((serverById.get(s.instanceId)?.x ?? NaN) - s.x) < 1e-6);
const notice = (await page.evaluate(() => window.__alerts)).join(' | ');
console.log('every member back where it began, on screen (should be true):', sameOnScreen);
console.log('every member back where it began, on the server (should be true):', sameOnServer);
console.log('notice:', notice);
await finish(browser, {
  pass: sameOnScreen && sameOnServer && /put back/.test(notice) && putCalls >= 3 && errors.filter((e) => !/Failed to load resource/.test(e)).length === 0,
  label: '#4403: a bundle save the server refuses part of puts every member back, on screen and on the server',
  errors: errors.filter((e) => !/Failed to load resource/.test(e)),
});
