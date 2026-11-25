// #4115 (part of #4062): Build judged each brick of a wall by its own distance from the camera, so a wall was
// cut by an edge between two versions that swept across it as the camera moved. Build now judges a bundle,
// and loose items that stand together, as one set (src/shop/lodSets.js, shared with Shop): the whole wall
// changes version as one.
//
// Seeds a wall of touching placements of one 5,120-triangle model (a generated icosphere) longer than the
// full-detail ring around the point the camera looks at (10 m), so judged one by one the bricks inside the ring
// are full and the rest are reduced: the edge. Checks that with the grouping switched off the wall is split,
// with it on the whole wall is on one version, and that the grouping changes nothing the builder sees (no
// item is added or lost).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';
import { icosphereGlb } from '../scripts/icosphere-glb.mjs';

const LABEL = 'Build Lod Sets Tester';
const LENGTH = 18; // 14.4 m of wall: longer than the 10 m full-detail ring (and its 13 m exit)
const HEIGHT = 2;
const COUNT = LENGTH * HEIGHT;
const { glb, triangles } = icosphereGlb(4, 0.4);
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const fetchJson = (route, options) => page.evaluate(async ([p, opts]) => {
  const res = await fetch(p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}, [route, options]);
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const modelUrl = await page.evaluate(async (bytes) => {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' }), 'lod-sets-ball.glb');
  const res = await fetch('/api/models', { method: 'POST', body: form });
  return (await res.json()).modelUrl;
}, [...glb]);
check(typeof modelUrl === 'string', 'the model uploads');
const { body: sellerBody } = await fetchJson('/api/sellers/me');
const { body: templateBody, status: templateStatus } = await fetchJson('/api/catalog', json({
  name: 'Lod Sets Ball', category: 'building-materials', color: '#d98a3a', dimensions: { width: 0.8, depth: 0.8, height: 0.8 },
  priceCents: 100, sellerId: sellerBody.seller.sellerId, modelUrl, metadata: {},
}));
check(templateStatus === 201, `the template is created (${templateStatus})`);
const templateId = templateBody.template.templateId;

const { body: buildersBody } = await fetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landletId = landletsBody.landlets[0].landletId;
// A wall 18 long and 2 high, the placements touching (0.8 m models 0.8 m apart): one thing to look at.
const ids = Array.from({ length: COUNT }, (_, i) => `lod-sets-ball-${i}`);
const instances = ids.map((instanceId, i) => ({
  instanceId, landletId, templateId, x: -1 + (i % LENGTH) * 0.8, y: 0, z: 0.4 + Math.floor(i / LENGTH) * 0.8,
}));
check((await fetchJson('/api/instances/batch', json({ instances }))).status === 201, 'the placements are created');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForFunction((n) => window.__testProductScreenPositions().length === n, COUNT, { timeout: 90000 });

const tick = () => page.evaluate(() => window.__testBuildLodTick());
const counts = () => page.evaluate(() => window.__testBuildLodCounts());
const tiers = () => page.evaluate((list) => list.map((id) => window.__testBuildLodTierOf(id)), ids);
async function settle(predicate, label) {
  for (let i = 0; i < 60; i++) {
    await tick();
    await page.waitForTimeout(250);
    if (predicate(await counts())) return true;
  }
  console.log(`${label}: counts ${JSON.stringify(await counts())}`);
  return false;
}

// The first load's fog has cleared. Protection around the point being looked at stays on, as it is for a builder:
// the bricks within 10 m of it are always the real model, and the rest take their version from their own size on
// screen (the versions are asked for once something wants a reduced one).
await page.waitForFunction(() => window.__testBuildArrivingCount() === 0, null, { timeout: 30000 });
await tick();

await page.evaluate(() => window.__testSetBuildImplicitLodSets(false));
await settle((c) => c.full >= 1 && c.mid + c.far >= 1, 'the wall splits when each placement is judged alone');
console.log('orbit target and wall: the first ' + (await tiers()).filter((t) => t === 'full').length + ' of ' + COUNT + ' are inside the ring');
const alone = new Set(await tiers());
console.log('judged one by one:', JSON.stringify([...alone]), JSON.stringify(await counts()));
check(alone.size > 1, `judged one by one the wall is on more than one version (${[...alone]})`);
check((await page.evaluate(() => window.__testBuildLodSetCount())) === 0, 'and there is no set');

await page.evaluate(() => window.__testSetBuildImplicitLodSets(true));
// The layout has stood still: the sets are worked out on the next pass.
await tick();
await tick();
await settle(() => true, 'a pass after the sets are worked out');
const together = new Set(await tiers());
console.log('judged as one set:', JSON.stringify([...together]), JSON.stringify(await counts()));
check((await page.evaluate(() => window.__testBuildLodSetCount())) === 1, 'the touching placements are one set');
check(together.size === 1, `judged as a set the whole wall is on one version (${[...together]})`);

// Nothing the builder sees changed: every placement is still there, drawn, and none is a bundle.
const after = await counts();
// (Items drawn in full have not needed their reduced versions, so they are counted as without them.)
check(after.full + after.mid + after.far + after.withoutVersions === COUNT && after.held === 0, `every item is still drawn: none is lost (${JSON.stringify(after)})`);
const positions = await page.evaluate(() => window.__testProductScreenPositions().length);
check(positions === COUNT, `the same ${COUNT} placements are there to be selected (${positions})`);

await finish(browser, { pass: pass && errors.length === 0, label: 'build-lod-sets (#4115)', errors });
