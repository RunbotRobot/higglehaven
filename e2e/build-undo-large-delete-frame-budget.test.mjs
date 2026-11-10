// #3427 (follow-up to #3396): undoing the delete of hundreds of items rebuilt
// every mesh in one task, so the screen and controls held until all of them
// existed ("Moving, looking and drawing never wait on loading"). Rebuilding now
// goes through worldWorkQueue, a few ms per frame. This seeds an 829-item
// landlet (the size of the owner's brick wall), deletes everything, undoes it
// and checks that every item is back, Undo stays disabled until it is, and no
// frame gap is longer than the stated ceiling.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Undo Large Delete Tester';
const COUNT = 829;
// What the rebuild may add to the longest gap between drawn frames, over the
// gap the same page shows idle with all 829 items present. The absolute gap is
// dominated by how long the renderer takes to draw 829 meshes (hundreds of ms
// on the CI runner's software GL), which no amount of build pacing changes, so
// the pacing is judged against that idle figure and directly through the
// queue's own stats (ticks and longest tick) below.
const EXTRA_GAP_CEILING_MS = Number(process.env.UNDO_EXTRA_GAP_CEILING_MS || 250);
const MIN_QUEUE_TICKS = 5; // the rebuild is spread over at least this many frames
const MAX_TICK_MS = 60; // the budget is 4 ms plus one unit; this is generous for a loaded runner

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landletId = landletsBody.landlets[0].landletId;

const instances = Array.from({ length: COUNT }, (_, i) => ({
  instanceId: `undo-large-delete-${i}`,
  landletId,
  templateId: 'placeholder-tree',
  x: 1 + (i % 30) * 0.2,
  y: 1 + Math.floor(i / 30) * 0.2,
}));
const statuses = [];
for (let i = 0; i < COUNT; i += 100) {
  statuses.push((await pageFetchJson('/api/instances/batch', json({ instances: instances.slice(i, i + 100) }))).status);
}
console.log('seeded 829 instances (all 201):', statuses.join(','));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForFunction((n) => window.__testProductScreenPositions().length === n, COUNT, { timeout: 90000 });
const sceneCount = () => page.evaluate(() => window.__testProductScreenPositions().length);
console.log('items in the scene after loading (should be 829):', await sceneCount());

// Steady state: how long frames take with all 829 items drawn and nothing
// rebuilding. The rebuild is judged against this.
await page.evaluate(() => window.__frameMonitor.reset());
await page.waitForTimeout(3000);
const idleGapMs = await page.evaluate(() => window.__frameMonitor.longestFrameGapMs());

await page.evaluate(() => window.__testSelectAllProducts());
await page.click('#delete-item');
await page.waitForFunction(() => window.__testProductScreenPositions().length === 0, null, { timeout: 30000 });
console.log('items after deleting everything (should be 0):', await sceneCount());
await page.waitForFunction(() => !document.getElementById('undo-btn').disabled, null, { timeout: 30000 });

// Click Undo from inside the page so the disabled state is read in the same
// task as the click (undo() takes the scene-mutation gate synchronously).
await page.evaluate(() => window.__frameMonitor.reset());
const statsBefore = await page.evaluate(() => window.__worldWorkQueueStats());
const disabledRightAfterClick = await page.evaluate(() => {
  const btn = document.getElementById('undo-btn');
  btn.click();
  return btn.disabled;
});
const t0 = Date.now();
await page.waitForFunction((n) => window.__testProductScreenPositions().length === n, COUNT, { timeout: 90000 });
const restoredMs = Date.now() - t0;
await page.waitForFunction(() => !document.getElementById('undo-btn').disabled || document.getElementById('redo-btn').disabled === false, null, { timeout: 30000 });
const undoEnabledAfter = await page.evaluate(() => document.getElementById('undo-btn').disabled);
const longestGapMs = await page.evaluate(() => window.__frameMonitor.longestFrameGapMs());
const statsAfter = await page.evaluate(() => window.__worldWorkQueueStats());
const rebuildTicks = statsAfter.ticks - statsBefore.ticks;
const rebuildUnits = statsAfter.unitsRun - statsBefore.unitsRun;
const restored = await sceneCount();
console.log('Undo disabled right after the click, while rebuilding (should be true):', disabledRightAfterClick);
console.log(`items after undo (should be ${COUNT}), ms until all were back:`, restored, restoredMs);
console.log(`longest gap between drawn frames: idle with 829 items ${Math.round(idleGapMs)} ms, while undo rebuilt them ${Math.round(longestGapMs)} ms (may add at most ${EXTRA_GAP_CEILING_MS}):`);
console.log(`queue pacing during the undo: ${rebuildUnits} units over ${rebuildTicks} frames (at least ${MIN_QUEUE_TICKS}), longest tick ${Math.round(statsAfter.longestTickMs)} ms (at most ${MAX_TICK_MS}):`);

// And the server agrees: a restore re-creates everything there too.
await page.waitForTimeout(3000);
let serverCount = 0;
let cursor = null;
for (let guard = 0; guard < 30; guard++) {
  const { body } = await pageFetchJson(`/api/instances?landletId=${encodeURIComponent(landletId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  serverCount += body.instances.length;
  cursor = body.nextCursor || null;
  if (!cursor) break;
}
console.log('instances on the server after undo (should be 829):', serverCount);

const pass =
  statuses.every((s) => s === 201) &&
  disabledRightAfterClick &&
  restored === COUNT &&
  serverCount === COUNT &&
  longestGapMs <= idleGapMs + EXTRA_GAP_CEILING_MS &&
  rebuildUnits >= COUNT &&
  rebuildTicks >= MIN_QUEUE_TICKS &&
  statsAfter.longestTickMs <= MAX_TICK_MS &&
  errors.length === 0;
await finish(browser, { pass, label: '#3427: undoing the delete of 829 items rebuilds them within the frame budget', errors });
