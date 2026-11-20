// #3929 (follows #3902, #3403): Build drew every placement from its full model, every frame (a wall of
// 1,650 bricks of 5,120 triangles was ~6.4 million triangles standing still). Build now runs Shop's
// level-of-detail rule over its items (src/build/lod.js): beyond the full-detail triangle budget an item
// is drawn from its mid or far version, the selected items and those around the orbit target are always
// the real model, and a tap on a far item still selects it, after which it is drawn in full.
//
// Seeds 30 placements of one 5,120-triangle model (a generated icosphere), lowers the budget so most of
// them must drop, and checks: the bulk of them are drawn from a reduced version, none is lost, a tap on a
// reduced one selects it and puts it back to full, and raising the budget returns everything to full.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';
import { icosphereGlb } from '../scripts/icosphere-glb.mjs';

const LABEL = 'Build Lod Tester';
const COUNT = 30;
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

// The model, uploaded as the builder's own seller, and one catalog template for it.
const modelUrl = await page.evaluate(async (bytes) => {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' }), 'lod-ball.glb');
  const res = await fetch('/api/models', { method: 'POST', body: form });
  return (await res.json()).modelUrl;
}, [...glb]);
check(typeof modelUrl === 'string', 'the model uploads');
const { body: sellerBody } = await fetchJson('/api/sellers/me');
const { body: templateBody, status: templateStatus } = await fetchJson('/api/catalog', json({
  name: 'Lod Ball', category: 'building-materials', color: '#d98a3a', dimensions: { width: 0.8, depth: 0.8, height: 0.8 },
  priceCents: 100, sellerId: sellerBody.seller.sellerId, modelUrl, metadata: {},
}));
check(templateStatus === 201, `the template is created (${templateStatus})`);
const templateId = templateBody.template.templateId;

const { body: buildersBody } = await fetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landletId = landletsBody.landlets[0].landletId;
const instances = Array.from({ length: COUNT }, (_, i) => ({
  instanceId: `lod-ball-${i}`, landletId, templateId, x: -4 + (i % 6) * 1.6, y: -4 + Math.floor(i / 6) * 1.6, z: 0.4,
}));
check((await fetchJson('/api/instances/batch', json({ instances }))).status === 201, 'the placements are created');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForFunction((n) => window.__testProductScreenPositions().length === n, COUNT, { timeout: 90000 });

const tick = () => page.evaluate(() => window.__testBuildLodTick());
const counts = () => page.evaluate(() => window.__testBuildLodCounts());
async function settle(predicate, label) {
  for (let i = 0; i < 60; i++) {
    await tick();
    await page.waitForTimeout(250);
    if (predicate(await counts())) return true;
  }
  console.log(`${label}: counts ${JSON.stringify(await counts())}`);
  return false;
}

// Nothing is over any budget yet: every item is drawn in full.
await settle((c) => c.mid + c.far === 0, 'nothing is reduced at the start');
const start = await counts();
console.log(`${triangles}-triangle model, ${COUNT} placements, default budget:`, JSON.stringify(start));
check(start.mid + start.far === 0, 'standing beside them with the default budget, no item is drawn from a reduced version');

await page.waitForTimeout(800);
const drawnBefore = await page.evaluate(() => window.__testBuildRenderedTriangles());
// A budget that fits only a couple of them, with nothing protected but the selection.
await page.evaluate(() => { window.__testSetBuildLodProtectNear(false); window.__testSetBuildFullTriangleCap(2 * 5120); });
const reduced = await settle((c) => c.full <= 2 && c.mid + c.far >= COUNT - 2, 'most drop to a reduced version');
const afterDrop = await counts();
console.log('after lowering the budget to two models:', JSON.stringify(afterDrop));
check(reduced, 'most of the items are drawn from a reduced version once over the budget');
check(afterDrop.full + afterDrop.mid + afterDrop.far === COUNT, 'every item is still drawn: none is lost');
await page.waitForTimeout(800);
const drawnAfter = await page.evaluate(() => window.__testBuildRenderedTriangles());
console.log(`triangles in the last frame: ${drawnBefore} before, ${drawnAfter} after`);
check(drawnBefore >= COUNT * triangles * 0.9, `all ${COUNT} models in full draw about ${COUNT * triangles} triangles (${drawnBefore})`);
check(drawnAfter < drawnBefore / 3, `the frame is a fraction of that once the budget bites (${drawnAfter} of ${drawnBefore})`);

// Identical items that are not being worked on are drawn by one instanced mesh per version (#3929,
// src/build/batching.js): far fewer draw calls for the same items and the same triangles, and each item
// is still there to be tapped.
const batch = await page.evaluate(() => window.__testBuildBatchCounts());
const callsBatched = await page.evaluate(() => window.__testBuildRenderedCalls());
console.log('batches after the budget bites:', JSON.stringify(batch), `draw calls ${callsBatched}`);
check(batch.items >= COUNT - 4, `nearly every item is drawn by a batch (${batch.items} of ${COUNT})`);
check(batch.drawCalls <= 6 && batch.groups <= 3, `a few batches, not one per item (${JSON.stringify(batch)})`);
await page.evaluate(() => window.__testSetBuildBatching(false));
await settle(() => true, 'tick with batching off');
await page.waitForTimeout(800);
const callsUnbatched = await page.evaluate(() => window.__testBuildRenderedCalls());
const trianglesUnbatched = await page.evaluate(() => window.__testBuildRenderedTriangles());
await page.evaluate(() => window.__testSetBuildBatching(true));
await settle(() => true, 'tick with batching on again');
await page.waitForTimeout(800);
const callsOn = await page.evaluate(() => window.__testBuildRenderedCalls());
const trianglesOn = await page.evaluate(() => window.__testBuildRenderedTriangles());
console.log(`draw calls ${callsUnbatched} unbatched, ${callsOn} batched; triangles ${trianglesUnbatched} and ${trianglesOn}`);
check(callsOn < callsUnbatched - (COUNT - 8), `batching removes the per-item draw calls (${callsOn} against ${callsUnbatched})`);
check(Math.abs(trianglesOn - trianglesUnbatched) < trianglesUnbatched * 0.05 + 50, `and draws the same triangles (${trianglesOn} against ${trianglesUnbatched})`);

// A tap on a reduced item selects it, and it is then drawn in full.
const reducedId = await page.evaluate(() => {
  const positions = window.__testProductScreenPositions();
  const inView = positions.find((p) => window.__testBuildLodTierOf(p.instanceId) !== 'full' && p.x > 20 && p.x < 370 && p.y > 120 && p.y < 700);
  return inView ? { id: inView.instanceId, x: inView.x, y: inView.y } : null;
});
check(reducedId !== null, 'there is a reduced item on screen to tap');
if (reducedId) {
  await page.mouse.click(reducedId.x, reducedId.y);
  await page.waitForTimeout(500);
  const selected = await page.evaluate(() => window.__testSelectedItemState?.() ?? null);
  console.log('after tapping a reduced item:', JSON.stringify(selected));
  check(selected !== null && (await page.textContent('#item-card-name')) === 'Lod Ball', 'tapping a reduced item selects it');
  await settle(() => true, 'tick after selecting');
  check((await page.evaluate((id) => window.__testBuildLodTierOf(id), reducedId.id)) === 'full', 'the selected item is drawn in full');
}

// Raising the budget and protecting the neighbourhood of the orbit target returns everything to full.
await page.evaluate(() => { window.__testSetBuildFullTriangleCap(null); window.__testSetBuildLodProtectNear(true); });
const back = await settle((c) => c.full === COUNT, 'everything returns to full');
check(back, 'with the default budget again every item is drawn in full');

await finish(browser, { pass: pass && errors.length === 0, label: 'build-lod-tiers (#3929)', errors });
