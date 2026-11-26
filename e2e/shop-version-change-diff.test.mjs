// #4391 (leaf 1): a builder switches which version of their lándlet is live while a shopper stands on it.
// Before, the shopper's picture never changed until they walked away and back. Now what is in both versions is not
// touched, what is only in the old one fades out where it stands, and what is only in the new one arrives through
// fog. Two versions of a lándlet of loose boxes: v1 has keep, leave, move; v2 has keep, move (moved), arrive.
//   keep   -> same object (same three.js uuid), never dissolving
//   leave  -> still drawn but no longer interactive, dissolving, then gone (not removed in one frame)
//   move   -> the old one fades out and a new one arrives (a change is the old leaving and the new arriving)
//   arrive -> not there before; there after, arriving through a dissolve
import { launchPage, chooseIdentity, claimLandlet, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Version Change Diff Builder';
const STAMP = Date.now();
const TEMPLATE_ID = `version-diff-box-${STAMP}`;
const ID = { keep: `vd-keep-${STAMP}`, leave: `vd-leave-${STAMP}`, move: `vd-move-${STAMP}`, arrive: `vd-arrive-${STAMP}` };

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
const first = [await place(ID.keep, 0, 0), await place(ID.leave, 4, 0), await place(ID.move, -4, 0)];
const v1 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions`, jsonOptions('POST', { name: 'one' }));
const act1 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions/${v1.body.version.versionId}/activate`, jsonOptions('POST', {}));
console.log('setup statuses (template, three places, v1, activate):', created.status, first.map((r) => r.status), v1.status, act1.status);

// The second version: leave is gone, move stands somewhere else, arrive is new.
const removed = await pageFetchJson(`/api/instances/${ID.leave}`, { method: 'DELETE' });
const moved = await pageFetchJson(`/api/instances/${ID.move}`, jsonOptions('PATCH', { x: -4, y: 4 }));
const arrived = await place(ID.arrive, 0, 4);
const v2 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions`, jsonOptions('POST', { name: 'two' }));
console.log('second version statuses (delete, move, place, v2):', removed.status, moved.status, arrived.status, v2.status);

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
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y); window.__testForceShopProximityCheck(); }, [landlet.center.x, landlet.center.y]);

const state = (id) => page.evaluate((i) => window.__testShopVersionState(i), id);
// v1 is live: wait until its three items are drawn and every arrival has settled.
await page.waitForFunction((ids) => ids.every((id) => window.__testShopVersionState(id).inObjects), [ID.keep, ID.leave, ID.move], { timeout: 20000 });
await page.waitForFunction(() => window.__shopArrivalRun?.settled?.(), null, { timeout: 25000 });
const before = { keep: await state(ID.keep), leave: await state(ID.leave), move: await state(ID.move), arrive: await state(ID.arrive) };
console.log('before the switch (v1 live):', JSON.stringify(before));

// The builder switches to v2 while the shopper stands here. (The shopper's page learns of it on its next record
// refresh; forced here instead of waiting 20 s.)
const act2 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions/${v2.body.version.versionId}/activate`, jsonOptions('POST', {}));
console.log('activate v2 status:', act2.status);
await page.evaluate(() => window.__testForceShopLandletRecordRefresh());

// Sample the next few seconds: a leaving item must stay drawn (and dissolving) for a while, not vanish in a frame.
const samples = [];
const deadline = Date.now() + 9000;
while (Date.now() < deadline) {
  samples.push({ at: Date.now(), leave: await state(ID.leave), keep: await state(ID.keep), arrive: await state(ID.arrive), move: await state(ID.move) });
  if (samples.length > 3 && !samples.at(-1).leave.inGroup && samples.at(-1).arrive.inObjects) break;
  await page.waitForTimeout(150);
}
const counters = await page.evaluate(() => ({ ...window.__shopVersionChange }));
console.log('version change counters:', JSON.stringify(counters));

const leaveDrawnSamples = samples.filter((s) => s.leave.inGroup && !s.leave.inObjects);
const leaveSeenDissolving = leaveDrawnSamples.some((s) => s.leave.dissolving);
const keepUuids = new Set(samples.map((s) => s.keep.uuid));
const keepNeverDissolved = samples.every((s) => !s.keep.dissolving);
const arriveSeen = samples.some((s) => s.arrive.inObjects);
const leaveGoneAtEnd = !samples.at(-1).leave.inGroup;
const moveOldFadedAndNewArrived = samples.some((s) => s.move.inGroup);
const leaveDurationMs = leaveDrawnSamples.length ? leaveDrawnSamples.at(-1).at - leaveDrawnSamples[0].at : 0;
console.log('leave: drawn-but-not-interactive samples', leaveDrawnSamples.length, 'dissolving seen', leaveSeenDissolving, 'visible for ms', leaveDurationMs, 'gone at end', leaveGoneAtEnd);
console.log('keep: uuids seen', [...keepUuids].length, 'uuid unchanged', keepUuids.size === 1 && keepUuids.has(before.keep.uuid), 'never dissolved', keepNeverDissolved);

// Second half: a later change with more of both (v3 adds four boxes, v4 removes two of them) is applied the same way,
// the untouched items keep their objects through both, and the lándlet is never loaded again from scratch.
// (A batched item leaving, a sign, a calendar, a diff over the size limit and a load or arrival still under way fall
// back to a plain reload instead; that decision is unit-tested in versionDiff.test.js, since a batch needs a real model.)
const EXTRA = [1, 2, 3, 4].map((n) => `vd-extra-${n}-${STAMP}`);
const placedExtra = [];
for (const [index, id] of EXTRA.entries()) placedExtra.push((await place(id, -6 + index * 2, 9)).status);
const v3 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions`, jsonOptions('POST', { name: 'three' }));
const act3 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions/${v3.body.version.versionId}/activate`, jsonOptions('POST', {}));
async function refreshUntil(predicate) {
  for (let tries = 0; tries < 25; tries += 1) {
    await page.evaluate(() => window.__testForceShopLandletRecordRefresh());
    if (await page.evaluate(predicate)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
const v3Applied = await refreshUntil(() => window.__shopVersionChange.diffed >= 2);
await page.waitForFunction((ids) => ids.every((id) => window.__testShopVersionState(id).inObjects), EXTRA, { timeout: 20000 });
const keepSurvivedV3 = (await state(ID.keep)).uuid === before.keep.uuid;
const removeExtra = [await pageFetchJson(`/api/instances/${EXTRA[2]}`, { method: 'DELETE' }), await pageFetchJson(`/api/instances/${EXTRA[3]}`, { method: 'DELETE' })];
const v4 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions`, jsonOptions('POST', { name: 'four' }));
const act4 = await pageFetchJson(`/api/landlets/${landlet.landletId}/versions/${v4.body.version.versionId}/activate`, jsonOptions('POST', {}));
const v4Applied = await refreshUntil(() => window.__shopVersionChange.diffed >= 3);
await page.waitForFunction((ids) => ids.every((id) => !window.__testShopVersionState(id).inGroup), [EXTRA[2], EXTRA[3]], { timeout: 15000 });
const keepSurvivedV4 = (await state(ID.keep)).uuid === before.keep.uuid && (await state(EXTRA[0])).inObjects && (await state(EXTRA[1])).inObjects;
const finalCounters = await page.evaluate(() => ({ ...window.__shopVersionChange }));
console.log('second half:', JSON.stringify({ placedExtra, v3Applied, v4Applied, keepSurvivedV3, keepSurvivedV4, finalCounters }));
const secondHalfPass = placedExtra.every((status) => status === 201) && v3.status === 201 && act3.status === 200
  && removeExtra.every((r) => r.status < 300) && v4.status === 201 && act4.status === 200
  && v3Applied && v4Applied && keepSurvivedV3 && keepSurvivedV4 && finalCounters.plainReload === 0 && finalCounters.diffed === 3;

const frame = await page.evaluate(() => window.__shopFrameStats?.() ?? null).catch(() => null);
const pass = created.status === 201 && first.every((r) => r.status === 201) && v1.status === 201 && act1.status === 200
  && removed.status < 300 && moved.status < 300 && arrived.status === 201 && v2.status === 201 && act2.status === 200
  && before.keep.inObjects && before.leave.inObjects && before.move.inObjects && !before.arrive.inGroup
  && counters.diffed === 1 && counters.plainReload === 0 && counters.leaving === 2 && counters.arriving === 2 && counters.unchanged === 1
  && leaveDrawnSamples.length >= 3 && leaveSeenDissolving && leaveDurationMs >= 800 && leaveGoneAtEnd
  && keepUuids.size === 1 && keepUuids.has(before.keep.uuid) && keepNeverDissolved
  && arriveSeen && moveOldFadedAndNewArrived
  && secondHalfPass
  && errors.length === 0;
void frame;
await finish(browser, {
  pass,
  label: '#4391: a change of the live version, seen by a shopper on the lándlet, leaves what is in both versions untouched, '
    + 'fades out what left (still drawn, not interactive, gone only after the fade) and brings in what is new',
  errors,
});
