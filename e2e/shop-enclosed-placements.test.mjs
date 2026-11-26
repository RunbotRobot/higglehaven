// #4365 (found under #4293, "E1"): a placement enclosed by its neighbours is left out of what is drawn.
//
// Seeds a claimed lándlet with a block of 4 x 4 x 4 solid box bricks standing face to face (a product with
// reduced versions that are boxes too), and checks, at phone width in Shop: once the batch's versions are
// known and its arrival is over, exactly the 8 bricks in the middle are drawn by no set (the other 56 are),
// every placement is still there (loaded objects, so collision, reviews and attention see all 64), the
// cull never takes a brick on the block's outside, and walking away and back (every version change) never
// brings a left-out brick back.
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const LABEL = 'Enclosed Tester';


async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Shop mode clamps its camera to the world's size: the world must be big enough to stand 40 m from the block.
const adminCookie = await ensureAdminSession();
const worldPatch = await adminFetch('/world', adminCookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed: ${JSON.stringify(worldPatch.body)}`);
const filler = await adminFetch('/landlets', adminCookie, {
  method: 'POST',
  body: JSON.stringify({ landletId: `e2e-enclosed-filler-${crypto.randomUUID()}`, name: 'Enclosed Coverage Filler', areaM2: 300 * 300, centerX: 0, centerY: 0, status: 'generating' }),
});
if (filler.response.status !== 201) throw new Error(`filler landlet create failed: ${JSON.stringify(filler.body)}`);

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

async function pageFetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });


const BRICKS = 64;
const SIDE = 4;
const STEP = 0.5;
const { boxGlb } = await import('../scripts/icosphere-glb.mjs');
async function uploadGlb(name, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'model/gltf-binary' }), name);
  const res = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: form });
  const body = await res.json();
  if (res.status !== 200 && res.status !== 201) throw new Error(`model upload ${name} failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}
const full = boxGlb(12, STEP);
const fullUpload = await uploadGlb('enclosed-brick.glb', full.glb);
const midUpload = await uploadGlb('enclosed-brick-mid.glb', boxGlb(4, STEP).glb);
const farUpload = await uploadGlb('enclosed-brick-far.glb', boxGlb(1, STEP).glb);

const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const sessionCookie = (await page.context().cookies()).find((c) => c.name === 'hh_session');
const templateRes = await fetch(`${BASE_URL}/api/catalog`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: sessionCookie ? `hh_session=${sessionCookie.value}` : '' },
  body: JSON.stringify({
    name: 'Enclosed Test Brick', category: 'placeholder', color: '#d98a3a',
    dimensions: { width: STEP, depth: STEP, height: STEP },
    sellerId: sellerMeBody.seller.sellerId, modelUrl: fullUpload.modelUrl, modelSizeBytes: fullUpload.sizeBytes, priceCents: 500,
    modelMidUrl: midUpload.modelUrl, modelFarUrl: farUpload.modelUrl,
  }),
});
const templateBody = await templateRes.json();
if (templateRes.status !== 200 && templateRes.status !== 201) throw new Error(`catalog template create failed (${templateRes.status}): ${JSON.stringify(templateBody)}`);
const templateId = templateBody.template.templateId;

const { body: buildersBody } = await pageFetchJson('/api/builders');
const builder = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

const instances = Array.from({ length: BRICKS }, (_, i) => ({
  instanceId: `enclosed-${i}`,
  landletId: landlet.landletId,
  templateId,
  x: (i % SIDE) * STEP,
  y: Math.floor(i / SIDE) % SIDE * STEP,
  z: Math.floor(i / (SIDE * SIDE)) * STEP,
}));
const statuses = [];
for (let i = 0; i < BRICKS; i += 100) {
  statuses.push((await pageFetchJson('/api/instances/batch', json({ instances: instances.slice(i, i + 100) }))).status);
}
console.log(`seeded ${BRICKS} bricks (all 201):`, statuses.every((s) => s === 201));
const insideIds = instances.filter((_, i) => {
  const x = i % SIDE; const y = Math.floor(i / SIDE) % SIDE; const z = Math.floor(i / (SIDE * SIDE));
  return x > 0 && x < SIDE - 1 && y > 0 && y < SIDE - 1 && z > 0 && z < SIDE - 1;
}).map((i) => i.instanceId);

await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForTimeout(1000);

const joystickBox = await shopStickBox(page);
const joystickX = joystickBox.x + joystickBox.width / 2;
const joystickY = joystickBox.y + joystickBox.height / 2;
await page.mouse.move(joystickX, joystickY);
await page.mouse.down();
await page.mouse.move(joystickX + 25, joystickY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

const cx = landlet.center.x;
const cy = landlet.center.y;
const awayDist = Math.hypot(cx, cy);
const awayX = awayDist > 1 ? -cx / awayDist : 1;
const awayY = awayDist > 1 ? -cy / awayDist : 0;
const at = (back) => [cx + awayX * back, cy + awayY * back];
const moveTo = (point) => page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, point);
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const stats = () => page.evaluate(() => window.__testShopDrawStats());
const sum = (t) => t.full + t.mid + t.far;

// Beside the block: the batch loads its reduced versions (the rule needs to know they are boxes too) and, once
// its arrival is over, leaves out the middle.
await moveTo([cx, cy]);
await page.waitForFunction((n) => window.__testShopLoadedInstanceCount() === n, BRICKS, { timeout: 120000 });
const reached = await page.waitForFunction(() => { window.__testForceShopProximityCheck(); return window.__testShopDrawStats().batchEnclosed > 0; }, null, { timeout: 90000, polling: 500 }).then(() => true).catch(() => false);
check(reached, 'the cull applies to a block of solid bricks');
await page.waitForTimeout(1500);
const culled = await stats();
console.log('block, culled:', JSON.stringify({ tiers: culled.batchTiers, enclosed: culled.batchEnclosed, triangles: culled.triangles, drawCalls: culled.drawCalls }));
check(culled.batchEnclosed === 8, `exactly the 8 bricks in the middle are left out (${culled.batchEnclosed})`);
check(sum(culled.batchTiers) + culled.batchEnclosed === BRICKS && sum(culled.batchTiers) === BRICKS - 8, `the drawn sets plus the left-out bricks are every placement (${JSON.stringify(culled.batchTiers)} + ${culled.batchEnclosed})`);
check(culled.batchedPlacements === BRICKS, `the batch still has all ${BRICKS} placements (${culled.batchedPlacements})`);
const loaded = await page.evaluate(() => window.__testShopLoadedInstanceCount());
check(loaded === BRICKS, `every placement is still a loaded object for collision and reviews (${loaded})`);
const tiersOf = await page.evaluate((ids) => ids.map((id) => window.__testShopInstanceTier(id)), insideIds);
check(tiersOf.every((t) => t === 'hidden'), `the left-out ones are the inside ones (${JSON.stringify(tiersOf)})`);
const outsideHidden = await page.evaluate((ids) => {
  let n = 0;
  for (let i = 0; i < 64; i++) if (!ids.includes(`enclosed-${i}`) && window.__testShopInstanceTier(`enclosed-${i}`) === 'hidden') n++;
  return n;
}, insideIds);
check(outsideHidden === 0, `no brick on the outside of the block is left out (${outsideHidden})`);

// The proof that nothing on screen changes: look at the block from six places (four sides, two heights above) and draw the left-out bricks
// again in flat magenta with the ordinary depth test (a test hook). If none of them could be seen, not one magenta
// pixel is on the screen. The control draws them with the depth test off: then they are plainly there to be found,
// so a still with none is a real result and not a view that missed the block.
const blockCentre = [cx + (SIDE - 1) * STEP / 2, cy + (SIDE - 1) * STEP / 2];
const blockMiddleZ = (SIDE - 1) * STEP / 2;
const magentaIn = (png) => page.evaluate(async (b64) => {
  const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] < 25 && d[i + 2] > 235) n++;
  return n;
}, png.toString('base64'));
// Looks at the block from one place: the avatar stands `standoff` m from its middle on the side the heading comes
// from, at height `z`, with the view turned to `yaw` and tipped to `pitch` (so the block is dead ahead).
async function lookAtBlock({ yaw, pitch, standoff, z = 0 }) {
  await page.evaluate((y) => window.__testSetShopYaw(y), yaw);
  const view = await page.evaluate(() => window.__testShopCameraView());
  const heading = Math.hypot(view.dx, view.dy) || 1;
  await page.evaluate(([x, y, h]) => { window.__testTeleportShopAvatar(x, y, h); window.__testForceShopProximityCheck(); },
    [blockCentre[0] - (view.dx / heading) * standoff, blockCentre[1] - (view.dy / heading) * standoff, z]);
  await page.evaluate((p) => window.__testSetShopPitch(p), pitch);
  await page.waitForTimeout(1500);
}
// The views: four sides at two distances (so the block is seen from every direction, including from behind where the
// camera faces away from where it started), and from above looking down.
const views = [];
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  for (const standoff of [2.5, 8]) views.push({ label: `side yaw ${yaw.toFixed(2)} at ${standoff} m`, yaw, pitch: 0, standoff });
}
views.push({ label: 'above, 6 m up', yaw: 0, pitch: -1.45, standoff: 0.2, z: 6 }, { label: 'above, 12 m up at an angle', yaw: Math.PI / 2, pitch: -0.9, standoff: 7, z: 9 });
for (const v of views) {
  await lookAtBlock(v);
  const drawn = await page.evaluate(() => window.__testShopDrawEnclosed('marker'));
  await page.waitForTimeout(500);
  const hidden = await magentaIn(await page.screenshot());
  await page.evaluate(() => window.__testShopDrawEnclosed('xray'));
  await page.waitForTimeout(500);
  const xray = await magentaIn(await page.screenshot());
  await page.evaluate(() => window.__testShopDrawEnclosed(false));
  console.log(`${v.label}: the ${drawn} left-out bricks drawn again in magenta show ${hidden} pixels; with the depth test off ${xray}`);
  check(drawn === 8, `the proof drew the 8 left-out bricks (${drawn})`);
  check(xray > 20, `the control finds the markers on screen when nothing hides them (${v.label}: ${xray} pixels)`);
  check(hidden === 0, `none of the left-out bricks can be seen (${v.label}: ${hidden} magenta pixels)`);
}
await page.evaluate(() => { window.__testSetShopYaw(0); window.__testSetShopPitch(0); });

// Away and back: every change of version, and none brings a left-out brick back or loses another.
for (const point of [at(26), at(40), [cx, cy], at(30), [cx, cy]]) {
  await moveTo(point);
  await page.waitForTimeout(1500);
  const s = await stats();
  check(s.batchEnclosed === 8 && sum(s.batchTiers) === BRICKS - 8, `at (${Math.round(point[0])}, ${Math.round(point[1])}) the same 8 stay out and the other 56 are drawn: ${JSON.stringify(s.batchTiers)} + ${s.batchEnclosed}`);
}

await moveTo(at(130));
await page.waitForFunction(() => window.__testShopLoadedInstanceCount() === 0, null, { timeout: 30000 });
await page.waitForTimeout(3000);
const unloaded = await stats();
check(unloaded.batches === 0 && unloaded.batchEnclosed === 0, 'leaving drops the batch and what it left out');

await finish(browser, { pass: pass && errors.length === 0, label: '#4365: placements enclosed by their neighbours are left out of what is drawn', errors });
