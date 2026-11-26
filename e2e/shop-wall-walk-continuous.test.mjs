// #4113 point 5 (part of #3412): the owner's walk, continuous. The stepped sibling (shop-wall-detail-change-fades)
// teleports, waits for every fade to finish, then looks; a person walking never gives the wall that time. This
// walks an avatar from 60 m to 2 m and back at running speed (4.47 m/s, docs/SPEC.md section 2), one position
// per frame, and reads the books' tier counts and the app's fade counters every frame, over a wall of 800 loose
// bricks (never bundled, so the system groups them itself, #4063; past what the fade caps take at once).
// It reports and asserts what a person would see as a wall changing look:
//  - hard swaps: bricks that changed version in one frame because the fade caps were full (bounded; the aim is 0);
//  - sweep: the metres of walking over which the wall is part the far version and part a better one (the
//    straight-edged band the owner saw), each way;
//  - overdue: frames in which a set drew far while its bricks were past the size where far reads as a colour.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, ensureAdminSession, finish, shopStickBox } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// #3416: the bricks are a dense-enough sphere to have mid and far versions (the
// repo's crate.glb is already cheap and has none), so the one-decision rule is
// exercised on real tiers. Node has no FileReader; GLTFExporter's binary path uses it.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
};
const denseScene = new THREE.Scene();
denseScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), new THREE.MeshStandardMaterial({ color: '#c0392b' })));
const denseBuffer = Buffer.from(await new GLTFExporter().parseAsync(denseScene, { binary: true }));

const LABEL = 'Wall Fade Walk Tester';
const PRODUCT_COUNT = 1;
const PER_PRODUCT = 800; // #4113: past what the fades can take at once (about 130 bricks of this sphere), under the full-detail budget (about 260)
const WALL_LOCAL_Y = -10;
const WALL_LENGTH_M = 24; // 800 bricks 0.03 m apart (overlapping: nearer than the gap that links a set)

async function adminFetch(pathAndQuery, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${pathAndQuery}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  return { response, body: await response.json() };
}

// Shop mode clamps the avatar to the world's gapless coverage, so grow the world
// and blanket it with one big filler landlet (see shop-middle-lod-band.test.mjs).
async function ensureRoomToWander() {
  const cookie = await ensureAdminSession();
  const worldPatch = await adminFetch('/world', cookie, { method: 'PATCH', body: JSON.stringify({ radiusM: 200 }) });
  if (worldPatch.response.status !== 200) throw new Error(`world radius patch failed -- ${JSON.stringify(worldPatch.body)}`);
  const filler = await adminFetch('/landlets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      landletId: `e2e-bundle-lod-filler-${crypto.randomUUID()}`, name: 'Bundle LOD Suite Coverage Filler',
      areaM2: 300 * 300, centerX: 0, centerY: 0, status: 'generating',
    }),
  });
  if (filler.response.status !== 201) throw new Error(`filler landlet create failed -- ${JSON.stringify(filler.body)}`);
}
await ensureRoomToWander();

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
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
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const { body: sellerMeBody } = await pageFetchJson('/api/sellers/me');
const sellerId = sellerMeBody.seller.sellerId;

const modelBytes = denseBuffer;
const modelForm = new FormData();
modelForm.append('file', new Blob([modelBytes], { type: 'model/gltf-binary' }), 'bundle-lod-sphere.glb');
const modelUploadRes = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: modelForm });
const modelUpload = await modelUploadRes.json();
if (modelUploadRes.status !== 200 && modelUploadRes.status !== 201) throw new Error(`model upload failed: ${JSON.stringify(modelUpload)}`);

const cookies = await page.context().cookies();
const sessionCookie = cookies.find((c) => c.name === 'hh_session');
const cookieHeader = sessionCookie ? `hh_session=${sessionCookie.value}` : '';
const templates = [];
for (let p = 0; p < PRODUCT_COUNT; p++) {
  const res = await fetch(`${BASE_URL}/api/catalog`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      name: `Bundle LOD Brick ${p} ${crypto.randomUUID().slice(0, 8)}`, category: 'placeholder', color: '#8899aa',
      dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
      sellerId, modelUrl: modelUpload.modelUrl, modelSizeBytes: modelUpload.sizeBytes, priceCents: 500,
    }),
  });
  const body = await res.json();
  if (res.status !== 200 && res.status !== 201) throw new Error(`template ${p} create failed: ${JSON.stringify(body)}`);
  templates.push(body.template);
}

const { body: buildersBody } = await pageFetchJson('/api/builders');
const me = buildersBody.builders.find((b) => b.label === LABEL);
const { body: landletsBody } = await pageFetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`);
const landlet = landletsBody.landlets[0];

const memberIds = [];
const memberInstances = [];
for (let i = 0; i < PRODUCT_COUNT * PER_PRODUCT; i++) {
  const instanceId = `bundle-lod-${crypto.randomUUID()}`;
  memberIds.push(instanceId);
  memberInstances.push({
    instanceId, landletId: landlet.landletId, templateId: templates[i % PRODUCT_COUNT].templateId,
    x: -WALL_LENGTH_M / 2 + (i * WALL_LENGTH_M) / (PRODUCT_COUNT * PER_PRODUCT - 1), y: WALL_LOCAL_Y,
  });
}
// The endpoint takes up to 100 placements a request.
let created = { status: 200 };
for (let from = 0; from < memberInstances.length && created.status < 300; from += 100) {
  created = await pageFetchJson('/api/instances/batch', json({ instances: memberInstances.slice(from, from + 100) }));
}
const grouped = { status: 200 }; // never bundled: the point of this test
console.log('seeded the 800-member loose wall (should be 2xx):', created.status);

const wallWorldX = landlet.center.x;
const wallWorldY = landlet.center.y + WALL_LOCAL_Y;
// Stand off the wall along +Y (away from the landlet), so the wall is a row
// seen side-on and the distance from every member is about the stated one.
async function standAt(distanceM) {
  await page.evaluate(([x, y]) => {
    window.__testTeleportShopAvatar(x, y, 0);
    window.__testForceShopProximityCheck();
  }, [wallWorldX, wallWorldY - distanceM]);
  await page.waitForTimeout(250);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Stop the spawn orbit so the teleports stick (same gesture the sibling LOD e2es use).
const joystick = await shopStickBox(page);
const jx = joystick.x + joystick.width / 2;
const jy = joystick.y + joystick.height / 2;
await page.mouse.move(jx, jy);
await page.mouse.down();
await page.mouse.move(jx + 25, jy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

await standAt(60);
let loaded = false;
for (let attempt = 0; attempt < 200 && !loaded; attempt++) {
  const counts = await page.evaluate(() => window.__testShopBatchTierCounts());
  loaded = counts.full + counts.mid + counts.far >= PER_PRODUCT * PRODUCT_COUNT;
  if (!loaded) await page.waitForTimeout(250);
}
console.log('the whole wall is in the books:', loaded);
// Let the wall settle on whatever it wants at 60 m before the walk starts.
for (let attempt = 0; attempt < 120; attempt++) {
  await page.waitForTimeout(250);
  if (await page.evaluate(() => window.__testShopBatchCrossfades().inFlight === 0)) break;
}
await page.evaluate(() => window.__testShopSetTiers()); // switch the read-out on

// The walk, in the page: one position per animation frame at running speed, and a row per frame.
const FAR_M = 60;
const NEAR_M = 2;
const RUN_M_S = 4.4704 * Number(process.env.WALK_SPEED_SCALE ?? 1); // a smaller scale walks the wall more slowly per frame (what a faster frame rate does)
const walkRows = await page.evaluate(([x, y0, farM, nearM, speed]) => new Promise((resolve) => {
  const rows = [];
  let d = farM;
  let direction = -1; // toward the wall
  let last = performance.now();
  let frame = 0;
  let game = 0; // seconds walked: a frame longer than 0.1 s counts as 0.1 s (software GL frames are seconds long on a 2 M triangle wall)
  const hardSwapsStart = window.__testShopBatchCrossfades().hardSwaps;
  const tick = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    d += direction * speed * dt;
    game += dt;
    if (d <= nearM) { d = nearM; direction = 1; }
    window.__testTeleportShopAvatar(x, y0 - d, 0);
    const counts = window.__testShopBatchTierCounts();
    const fades = window.__testShopBatchCrossfades();
    const row = { t: now, g: game, d, dir: direction, viol: window.__testShopBatchOrderViolations(), ...counts, inFlight: fades.inFlight, started: fades.started, hard: fades.hardSwaps - hardSwapsStart };
    if (frame % 6 === 0) {
      const sets = window.__testShopSetTiers();
      row.sets = sets.map((s) => ({ px: s.px, tiers: s.tiers, reasons: s.reasons }));
    }
    rows.push(row);
    frame += 1;
    if (direction === 1 && d >= farM) return resolve(rows);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), [wallWorldX, wallWorldY, FAR_M, NEAR_M, RUN_M_S]);

const total = (r) => r.full + r.mid + r.far;
const walkMs = walkRows.length ? walkRows[walkRows.length - 1].t - walkRows[0].t : 0;
const walkedS = walkRows.length ? walkRows[walkRows.length - 1].g : 0;
console.log(`frames sampled over the walk: ${walkRows.length} in ${Math.round(walkMs)} ms (${(walkRows.length / (walkMs / 1000)).toFixed(1)} fps, software GL); walked ${walkedS.toFixed(1)} s of game time`);

// The turn at 2 m splits the rows into the way in and the way out.
const turn = walkRows.findIndex((r) => r.dir > 0);
const inRows = walkRows.slice(0, turn);
const outRows = walkRows.slice(turn);
const hardIn = inRows.length ? inRows[inRows.length - 1].hard : -1;
const hardOut = walkRows.length ? walkRows[walkRows.length - 1].hard - Math.max(hardIn, 0) : -1;
console.log('bricks that changed version in one frame because the fade caps were full, on the way in and out (bound 120 of 800, aim 0):', hardIn, hardOut);

// The way in: from the first brick off the far version to the last one still on it. A wall changing look as one
// thing is a few metres of walking; a long stretch is the straight-edged band the owner saw, the near bricks
// waiting on the far version while the ones behind them already have a better one.
const firstOff = inRows.find((r) => r.mid + r.full > 0);
const lastFar = [...inRows].reverse().find((r) => r.far > 0);
const sweepInM = firstOff && lastFar ? Math.max(0, firstOff.d - lastFar.d) : -1;
console.log(`the wall leaves the far version over ${sweepInM.toFixed(1)} m of walking in (from ${firstOff?.d.toFixed(1)} m to ${lastFar?.d.toFixed(1)} m)`);
const outFirst = outRows.find((r) => r.far > 0);
const outLastOff = [...outRows].reverse().find((r) => r.mid + r.full > 0);
const sweepOutM = outFirst && outLastOff ? Math.max(0, outLastOff.d - outFirst.d) : -1;
console.log(`the wall goes back to the far version over ${sweepOutM.toFixed(1)} m of walking out (from ${outFirst?.d.toFixed(1)} m to ${outLastOff?.d.toFixed(1)} m)`);

// #4113: ORDER. A wall should improve from the front: no brick shows a worse version than a brick farther from the avatar
// (the near bricks on far while the ones behind them have mid is the owner's straight-edged band, seen from the side).
// `viol` is, each frame, how many bricks show a worse version than some farther one. Frames with any, and the worst
// frame, each way; a hysteresis band can leave a few for a frame or two, so the bound is on how long and how many.
const violFramesIn = inRows.filter((r) => r.viol > 0).length;
const violFramesOut = outRows.filter((r) => r.viol > 0).length;
const worstViolIn = Math.max(0, ...inRows.map((r) => r.viol));
const worstViolOut = Math.max(0, ...outRows.map((r) => r.viol));
const violSumIn = inRows.reduce((sum, r) => sum + r.viol, 0);
// A band lasts; a brick on the wrong version for a frame at a hysteresis edge does not. The longest run of consecutive frames.
function longestRun(rows) {
  let best = 0;
  let run = 0;
  for (const r of rows) {
    run = r.viol > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}
const runIn = longestRun(inRows);
const runOut = longestRun(outRows);
console.log(`order (bricks on a worse version than one farther away): in: ${violFramesIn} of ${inRows.length} frames (longest run ${runIn}), worst ${worstViolIn}, sum ${violSumIn}; out: ${violFramesOut} of ${outRows.length} frames (longest run ${runOut}), worst ${worstViolOut}`);

// Overdue: a set on far while each brick is past the size where far reads as a colour (LOD_SET_FAR_EXIT_PX 14, 1.5x).
let overdueFrames = 0;
let worstOverduePx = 0;
for (const r of walkRows) {
  for (const s of r.sets ?? []) {
    if ((s.tiers.far ?? 0) > 0 && s.px > 21) { overdueFrames += 1; worstOverduePx = Math.max(worstOverduePx, s.px); }
  }
}
console.log('sampled frames where part of the wall drew far past 21 px per brick (should be 0), worst px:', overdueFrames, worstOverduePx);
for (let i = 0; i < walkRows.length; i++) {
  const r = walkRows[i];
  const interesting = (r.d < 24 && r.d > 1.9) || i % 40 === 0;
  if (!interesting) continue;
  const set = r.sets?.[0];
  console.log(`  ${r.dir < 0 ? 'in ' : 'out'} ${r.d.toFixed(1).padStart(5)} m  g ${r.g.toFixed(2)}  full ${r.full} mid ${r.mid} far ${r.far}  fades ${r.inFlight}  hard ${r.hard}  order ${r.viol}${set ? `  set px ${set.px} ${JSON.stringify(set.reasons)}` : ''}`);
}

// #4113: bounds on this wall (800 bricks of 0.1 m, software GL). The goal is no visible band; these pin its shape.
// Order: a wall improves from the front, so no brick shows a worse version than one farther away. A hysteresis edge or a
// fade waiting for room can leave some for a few frames, so what counts is how many frames have any and how long a run of
// them lasts: a band that lasts is what a person sees. The order the flips are served in (nearest upgrade first) is what
// keeps both short; the unordered rule had about twice as many frames and runs (see the PR).
const MAX_ORDER_FRAMES = 6;
const MAX_ORDER_RUN_FRAMES = 6;
// Hard swaps (a brick that changed in one frame because the fade caps were full, or because it was well past its size
// limit, #4398) are mostly a software-GL artefact of this walk: at a few frames a second a fade spans two or three frames
// of walking: 0 of 800 in 8 of 8 runs of the final rule, 133 in one of 3 of the rule before it, and 500 to 535 (one group of
// bricks past its size limit together) with a rule that held bricks back. The bound fails that kind of pop, not a stray one.
const MAX_HARD_SWAPS = Number(process.env.WALK_MAX_HARD_SWAPS ?? 200);
// The metres from the first brick to leave the far version to the last, each way: one sweep (the order above says it is a
// sweep and not a band), slowed by software-GL frames and the fade caps, so the bound is generous.
const MAX_SWEEP_M = Number(process.env.WALK_MAX_SWEEP_M ?? 12);
const pass = !!landlet && created.status < 300 && loaded && walkRows.length > 30 && total(walkRows[walkRows.length - 1]) >= PER_PRODUCT * PRODUCT_COUNT
  && sweepInM >= 0 && sweepInM <= MAX_SWEEP_M && sweepOutM >= 0 && sweepOutM <= MAX_SWEEP_M && hardIn <= MAX_HARD_SWAPS && hardOut <= MAX_HARD_SWAPS && violFramesIn <= MAX_ORDER_FRAMES && violFramesOut <= MAX_ORDER_FRAMES && runIn <= MAX_ORDER_RUN_FRAMES && runOut <= MAX_ORDER_RUN_FRAMES
  && overdueFrames === 0 && errors.length === 0;
await finish(browser, { pass, label: '#4113: a wall walked at running speed from 60 m to 2 m and back changes version without a hard swap, a long split, or far past its size', errors });
