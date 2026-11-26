// #4391 (leaf 1): a builder changes which version of their lándlet is live while a shopper stands on it.
// Before, the shopper's picture never changed until they walked away and back. Now what is in both versions is not
// touched, what is only in the old one fades out where it stands, and what is only in the new one arrives through
// fog. Phases, on one lándlet of loose boxes (no model, so each is an ordinary item):
//   0  never published (the shopper sees the draft); the builder publishes it: nothing is different, nothing is touched.
//   1  v2: keep stays, leave goes, move stands somewhere else, arrive is new.
//   2  v3 and v4 close together, so v4 lands while v3's items are still fading in / out.
//   3  an item arrives where the shopper stands: it is not an obstacle until they have stepped off.
//   4  an item leaves and the shopper walks away before its fade ends: nothing is left behind.
//   5  300 items arrive and then 300 leave: no long frame.
import { launchPage, chooseIdentity, claimLandlet, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Version Change Diff Builder';
const STAMP = Date.now();
const TEMPLATE_ID = `version-diff-box-${STAMP}`;
const ID = {
  keep: `vd-keep-${STAMP}`, leave: `vd-leave-${STAMP}`, move: `vd-move-${STAMP}`, arrive: `vd-arrive-${STAMP}`,
  p3: `vd-three-${STAMP}`, p4: `vd-four-${STAMP}`, here: `vd-here-${STAMP}`, away: `vd-away-${STAMP}`,
};
const MAX_FRAME_GAP_MS = Number(process.env.E2E_MAX_FRAME_GAP_MS || 250);
const MANY = 300;

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [pathAndQuery, options]);
}
const jsonOptions = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
if (await page.locator('#seller-modal.visible').count()) {
  await page.waitForTimeout(300);
  await page.click('#seller-close-btn');
  await page.waitForTimeout(300);
}
const { body: sellerMe } = await pageFetchJson('/api/sellers/me');
const created = await pageFetchJson('/api/catalog', jsonOptions('POST', {
  templateId: TEMPLATE_ID, name: 'Version Diff Box', color: '#aa8866', dimensions: { width: 1, depth: 1, height: 1 },
  sellerId: sellerMe.seller.sellerId, priceCents: 500,
}));
const place = (id, x, y) => pageFetchJson('/api/instances', jsonOptions('POST', { instanceId: id, landletId: landlet.landletId, templateId: TEMPLATE_ID, x, y }));
const remove = (id) => pageFetchJson(`/api/instances/${id}`, { method: 'DELETE' });
const publish = async (name) => {
  const v = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions`, jsonOptions('POST', { name }));
  const act = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions/${v.body.version.versionId}/activate`, jsonOptions('POST', {}));
  return v.status === 201 && act.status === 200;
};

// Phase 0 setup: a draft only (never published).
const first = [await place(ID.keep, 0, 0), await place(ID.leave, 4, 0), await place(ID.move, -4, 0)];
check(created.status === 201 && first.every((r) => r.status === 201), 'the template and the first three boxes are created');

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const stick = await shopStickBox(page);
const cx = stick.x + stick.width / 2;
const cy = stick.y + stick.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
// z: 0 puts the avatar on the ground (a shopper who is flying cannot be trapped by anything).
const standAt = (x, y, z) => page.evaluate(([px, py, pz]) => { window.__testTeleportShopAvatar(px, py, pz ?? undefined); window.__testForceShopProximityCheck(); }, [landlet.center.x + x, landlet.center.y + y, z ?? null]);
await standAt(0, 6);

const state = (id) => page.evaluate((i) => window.__testShopVersionState(i), id);
const counters = () => page.evaluate(() => ({ ...window.__shopVersionChange }));
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - (a[k] ?? 0)]));
async function refreshUntil(predicate, arg) {
  for (let tries = 0; tries < 30; tries += 1) {
    await page.evaluate(() => window.__testForceShopLandletRecordRefresh());
    if (await page.evaluate(predicate, arg)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
const allIn = (ids) => page.waitForFunction((list) => list.every((id) => window.__testShopVersionState(id).inObjects), ids, { timeout: 25000 });
const allArrived = () => page.waitForFunction(() => window.__shopVersionChange && (window.__shopArrivalRun?.settled?.() ?? true), null, { timeout: 25000 });
await allIn([ID.keep, ID.leave, ID.move]);
await allArrived();
await page.waitForTimeout(500);

// ---- Phase 0: the first publish of a lándlet the shopper already has loaded changes nothing ----
const c0 = await counters();
const draftState = { keep: await state(ID.keep), leave: await state(ID.leave), move: await state(ID.move) };
check(await publish('one'), 'v1 is published and activated');
await refreshUntil((base) => window.__shopVersionChange.diffed > base, c0.diffed ?? 0);
const d0 = delta(c0, await counters());
const after0 = { keep: await state(ID.keep), leave: await state(ID.leave), move: await state(ID.move) };
check(d0.diffed === 1 && d0.plainReload === 0 && d0.leaving === 0 && d0.arriving === 0 && d0.unchanged === 3,
  `the first publish is a diff of nothing: ${JSON.stringify(d0)}`);
check(['keep', 'leave', 'move'].every((k) => after0[k].uuid === draftState[k].uuid && !after0[k].dissolving && after0[k].copies === 1),
  'after the first publish every item is the very same object, not dissolving, drawn once');

// ---- Phase 1: v2 ----
await remove(ID.leave);
await pageFetchJson(`/api/instances/${ID.move}`, jsonOptions('PATCH', { x: -4, y: 4 }));
await place(ID.arrive, 0, 4);
const c1 = await counters();
check(await publish('two'), 'v2 is published and activated');
await page.evaluate(() => window.__testForceShopLandletRecordRefresh());
const samples = [];
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  samples.push({ at: Date.now(), leave: await state(ID.leave), keep: await state(ID.keep), arrive: await state(ID.arrive), move: await state(ID.move) });
  const last = samples.at(-1);
  if (samples.length > 3 && !last.leave.inGroup && last.arrive.inObjects && last.move.copies === 1 && last.move.inObjects && last.move.y > 3) break;
  await page.waitForTimeout(120);
}
const d1 = delta(c1, await counters());
const leaveDrawn = samples.filter((s) => s.leave.inGroup && !s.leave.inObjects);
const leaveMs = leaveDrawn.length ? leaveDrawn.at(-1).at - leaveDrawn[0].at : 0;
check(d1.diffed === 1 && d1.plainReload === 0 && d1.leaving === 2 && d1.arriving === 2 && d1.unchanged === 1, `v2 is one diff: ${JSON.stringify(d1)}`);
check(leaveDrawn.length >= 3 && leaveDrawn.some((s) => s.leave.dissolving) && leaveMs >= 800 && !samples.at(-1).leave.inGroup,
  `the removed item stays drawn and dissolving for a while, then is gone (visible ${leaveMs} ms, ${leaveDrawn.length} samples)`);
check(leaveDrawn.every((s) => s.leave.obstacle === false) && samples.every((s) => s.keep.obstacle === true || s.keep.obstacle === false) && samples.at(-1).keep.obstacle,
  'a leaving item is not an obstacle from the first frame of its fade; the kept item is');
check(samples.every((s) => s.keep.uuid === after0.keep.uuid && !s.keep.dissolving && s.keep.copies === 1), 'the kept item stays the very same object, never dissolving, drawn once');
const moveDuring = samples.filter((s) => s.move.copies === 2);
const moveEnd = samples.at(-1).move;
check(moveDuring.length >= 1, 'the moved item is drawn twice for a while (the old one fading out, the new one arriving)');
check(moveEnd.copies === 1 && moveEnd.inObjects && Math.abs(moveEnd.x + 4) < 0.01 && Math.abs(moveEnd.y - 4) < 0.01,
  `at the end exactly one moved item stands at its new place (copies ${moveEnd.copies}, at ${moveEnd.x}, ${moveEnd.y})`);
check(samples.at(-1).arrive.inObjects && samples.at(-1).arrive.copies === 1, 'the new item arrived, drawn once');

// ---- Phase 2: v3 and v4 close together (v4 lands while v3's items are still arriving and leaving) ----
await allArrived();
await place(ID.p3, -8, 8);
await remove(ID.arrive);
const c2 = await counters();
check(await publish('three'), 'v3 is published and activated');
await page.evaluate(() => window.__testForceShopLandletRecordRefresh());
await page.waitForTimeout(700); // v3 is being applied: its item is still arriving and `arrive` is still fading out
await place(ID.p4, 8, 8);
await remove(ID.p3);
check(await publish('four'), 'v4 is published and activated while v3 is still settling');
await refreshUntil((ids) => !window.__testShopVersionState(ids[0]).inGroup && window.__testShopVersionState(ids[1]).inObjects, [ID.p3, ID.p4]);
await page.waitForFunction((ids) => ids.every((id) => window.__testShopVersionState(id).copies <= 1), [ID.keep, ID.move, ID.arrive, ID.p3, ID.p4], { timeout: 15000 });
const two = { arrive: await state(ID.arrive), p3: await state(ID.p3), p4: await state(ID.p4), keep: await state(ID.keep), move: await state(ID.move) };
const d2 = delta(c2, await counters());
check(!two.arrive.inGroup && !two.p3.inGroup && two.p4.inObjects && two.keep.uuid === after0.keep.uuid && two.keep.copies === 1 && two.move.copies === 1 && d2.plainReload === 0,
  `after v3 and v4 close together the picture is v4's, nothing double-drawn or left behind: ${JSON.stringify({ d2, p3: two.p3.inGroup, p4: two.p4.inObjects })}`);

// ---- Phase 3: an item arrives where the shopper stands ----
await allArrived();
await standAt(2, -2, 0);
await place(ID.here, 2, -2);
check(await publish('five'), 'v5 (an item where the shopper stands) is published and activated');
await refreshUntil((id) => window.__testShopVersionState(id).inObjects, ID.here);
await allArrived();
await page.waitForTimeout(600);
const underfoot = await state(ID.here);
check(underfoot.inObjects && underfoot.obstacle === false, `an item that arrived under the shopper is not an obstacle while they stand on it (obstacle ${underfoot.obstacle})`);
await standAt(2, 6, 0);
await page.waitForFunction((id) => window.__testShopVersionState(id).obstacle === true, ID.here, { timeout: 10000 }).catch(() => {});
check((await state(ID.here)).obstacle === true, 'once the shopper has stepped off it becomes an obstacle');

// ---- Phase 4: the shopper leaves while an item is still fading out ----
await place(ID.away, 6, 6);
await publish('six');
await refreshUntil((id) => window.__testShopVersionState(id).inObjects, ID.away);
await allArrived();
await remove(ID.away);
check(await publish('seven'), 'v7 (without the last item) is published and activated');
await refreshUntil((id) => !window.__testShopVersionState(id).inObjects, ID.away);
await standAt(5000, 5000); // far away: the lándlet unloads while that item is still fading out
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(500);
const leftBehind = await state(ID.away);
check(!leftBehind.inGroup && leftBehind.copies === 0, `an unload in the middle of a fade leaves nothing behind (copies ${leftBehind.copies})`);
await standAt(0, 6);
await page.waitForFunction((ids) => ids.every((id) => window.__testShopVersionState(id).inObjects), [ID.keep, ID.here], { timeout: 30000 });
check(!(await state(ID.away)).inGroup, 'coming back loads the live version (without the removed item)');

// ---- Phase 5: three hundred arrive, then three hundred leave: no long frame ----
const manyIds = Array.from({ length: MANY }, (_, i) => `vd-many-${i}-${STAMP}`);
const manyRows = manyIds.map((instanceId, i) => ({
  instanceId, landletId: landlet.landletId, templateId: TEMPLATE_ID, x: -7 + (i % 20) * 0.7, y: -14 + Math.floor(i / 20) * 0.7,
}));
for (let i = 0; i < MANY; i += 100) {
  const batch = await pageFetchJson('/api/instances/batch', jsonOptions('PUT', { instances: manyRows.slice(i, i + 100) }));
  check(batch.status === 200 || batch.status === 201, `300 items are placed (chunk ${i / 100}: ${batch.status})`);
}
await allArrived();
await page.evaluate(() => window.__frameMonitor.reset());
check(await publish('many'), 'v8 (300 more items) is published and activated');
await refreshUntil((ids) => ids.every((id) => window.__testShopVersionState(id).inObjects), manyIds.slice(0, 3));
await page.waitForFunction((ids) => ids.every((id) => window.__testShopVersionState(id).inObjects), manyIds.slice(-3), { timeout: 60000 });
const arrivalGap = await page.evaluate(() => window.__frameMonitor.longestFrameGapMs());
await allArrived();
await page.waitForTimeout(500);
await page.evaluate(async (ids) => { await Promise.all(ids.map((id) => fetch(`/api/instances/${id}`, { method: 'DELETE' }))); }, manyIds);
await page.evaluate(() => window.__frameMonitor.reset());
check(await publish('none'), 'v9 (the 300 gone again) is published and activated');
await refreshUntil((ids) => ids.every((id) => !window.__testShopVersionState(id).inObjects), manyIds.slice(0, 3));
await page.waitForFunction((ids) => ids.every((id) => !window.__testShopVersionState(id).inGroup), manyIds, { timeout: 60000 });
const leaveGap = await page.evaluate(() => window.__frameMonitor.longestFrameGapMs());
console.log(`300 arriving: longest frame gap ${Math.round(arrivalGap)} ms; 300 leaving (and gone): longest frame gap ${Math.round(leaveGap)} ms`);
check(arrivalGap < MAX_FRAME_GAP_MS, `300 items arriving never block a frame of ${MAX_FRAME_GAP_MS} ms or more (longest ${Math.round(arrivalGap)} ms)`);
check(leaveGap < MAX_FRAME_GAP_MS, `300 items leaving never block a frame of ${MAX_FRAME_GAP_MS} ms or more (longest ${Math.round(leaveGap)} ms)`);
const finalCounters = await counters();
check(finalCounters.plainReload === 0, `no change in this test needed a plain reload (${JSON.stringify(finalCounters)})`);

await finish(browser, {
  pass: pass && errors.length === 0,
  label: '#4391: a change of the live version, seen by a shopper on the lándlet, leaves what is in both versions untouched '
    + '(also on a first publish), fades out what left, brings in what is new, never traps a shopper, survives overlapping changes and an '
    + 'unload mid-fade, and never blocks a frame at 300 items',
  errors,
});
