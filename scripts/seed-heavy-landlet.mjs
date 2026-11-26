#!/usr/bin/env node
// #3929 (follows #3902, #3403): seeds a local `wrangler dev` world with one lándlet that carries a
// heavy wall -- about 1,650 placements of one 5,120-triangle catalog "brick" (the production
// wall is 1,655 copies of a 5,320-triangle brick; its reduced versions are described below) -- plus
// a few dozen mixed items, owned by a local account, so what Build, Shop and Sell cost per frame can
// be measured against a lándlet as heavy as the owner's.
//
//   npm run build && npx wrangler dev --local     # one terminal
//   node scripts/seed-heavy-landlet.mjs [--bricks 1650] [--no-tiers] [--mid-level 3] [--shape box] [--url http://127.0.0.1:8787]
//
// Prints one JSON line: { email, password, username, landletId, templateId, bricks }. Sign in with
// that account (scripts/live-frame-cost.mjs --login local does it for you). Local only: it creates
// accounts and uses the dev admin bootstrap secret, and refuses any URL that is not localhost.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icosphereGlb, boxGlb } from './icosphere-glb.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const BASE_URL = flag('--url', process.env.SEED_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE_URL)) {
  console.error('seed-heavy-landlet: this only runs against a local server (127.0.0.1 or localhost).');
  process.exit(1);
}
const BRICKS = Number(flag('--bricks', 1650));
// #3929: --products N adds N more products from the same seller (the brick model, 5,120 triangles each)
// so Sell's showroom can be measured with a full page (live-frame-cost --mode sell).
const EXTRA_PRODUCTS = Number(flag('--products', 0));
const ADMIN_BOOTSTRAP_SECRET = process.env.SEED_ADMIN_BOOTSTRAP_SECRET || 'local-dev-admin-secret';
const PASSWORD = 'heavy-landlet-seed-password-123';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = Date.now().toString(36);

async function api(route, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${route}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route} -> ${response.status}: ${body.error || JSON.stringify(body)}`);
  return body;
}

async function makeAccount(label) {
  const email = `${label}-${stamp}@heavy.local`;
  const response = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, username: `${label}-${stamp}`, ageAttested: true }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`signup ${label} -> ${response.status}: ${body.error}`);
  const cookie = response.headers.get('set-cookie')?.match(/hh_session=([^;]+)/)?.[0];
  await api('/auth/confirm-card', cookie, { method: 'POST' });
  return { email, username: `${label}-${stamp}`, cookie };
}

async function uploadModel(fileName, bytes) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'model/gltf-binary' }), fileName);
  const response = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(`upload ${fileName} -> ${response.status}: ${body.error}`);
  return body.modelUrl;
}

const GROW_MAX_STEPS = 20;
async function ensureLand(adminCookie) {
  const have = async () => (await api('/landlets?status=greenbelt&limit=1', adminCookie)).landlets.length > 0;
  for (let i = 0; i < GROW_MAX_STEPS && !(await have()); i++) {
    const { landlets: generating } = await api('/landlets?status=generating&limit=1', adminCookie);
    if (generating.length === 0) break;
    await api('/world/expand', adminCookie, { method: 'POST' }).catch(() => {});
  }
  if (await have()) return;
  let world = (await api('/world', adminCookie)).world;
  let innerRadiusM = world.radiusM;
  let ring = null;
  for (let attempt = 0; attempt < GROW_MAX_STEPS && !ring; attempt++) {
    const prefix = `heavy-ring-${Math.round(innerRadiusM)}-${stamp}`;
    try {
      const generated = await api('/land-candidates/generate-ring', adminCookie, { method: 'POST', body: JSON.stringify({ prefix, count: 12, innerRadiusM }) });
      ring = { ringId: prefix, outerRadiusM: generated.outerRadiusM };
    } catch (err) {
      if (!err.message.includes('overlap')) throw err;
      innerRadiusM += world.expansionIncrementM;
    }
  }
  if (!ring) throw new Error('could not find clear room for a new ring of land');
  for (let i = 0; i < GROW_MAX_STEPS; i++) {
    world = (await api('/world', adminCookie)).world;
    if (world.radiusM >= ring.outerRadiusM) break;
    await api('/world/expand', adminCookie, { method: 'POST' });
  }
  await api(`/land-candidate-rings/${ring.ringId}/generation-complete`, adminCookie, { method: 'POST' });
}

const admin = await makeAccount('heavyadmin');
await api('/auth/admin-bootstrap', admin.cookie, { method: 'POST', body: JSON.stringify({ secret: ADMIN_BOOTSTRAP_SECRET }) })
  .catch((err) => { throw new Error(`admin bootstrap failed (is ADMIN_BOOTSTRAP_SECRET "${ADMIN_BOOTSTRAP_SECRET}" in .dev.vars?): ${err.message}`); });
await ensureLand(admin.cookie);

const builder = await makeAccount('heavybuilder');
const { landlets } = await api('/landlets?status=greenbelt&limit=1', builder.cookie);
if (landlets.length === 0) throw new Error('no greenbelt lándlet to claim');
const landletId = (await api(`/landlets/${landlets[0].landletId}/claim`, builder.cookie, { method: 'POST' })).landlet.landletId;
const { seller } = await api('/sellers/me', builder.cookie);

// #4365: --shape box seeds the brick as a real solid box (5,292 triangles full, 1,200 mid, 12 far) instead of an
// icosphere, so a wall of it has an inside to leave out (an icosphere does not fill its box, so the enclosure
// rule rightly never culls a wall of them). The default stays the icosphere, so every figure taken before
// #4365 can still be repeated.
const BOX_SHAPE = flag('--shape', 'icosphere') === 'box';
const { glb, triangles } = BOX_SHAPE ? boxGlb(21, 0.5) : icosphereGlb(4, 0.25);
const brickModelUrl = await uploadModel('seed-brick.glb', glb);
// Stored reduced versions, as the upload optimiser leaves on a real product, so Shop and Build load
// them instead of building them in the browser frame by frame. Pass --no-tiers to leave them off and
// measure that path.
// #4302 (found under #4293): the first version of this seed used a 320-triangle mid, about a tenth of
// what the owner's wall carries, so every frame figure taken here (#4089, #4293, #4294, the numbers on
// #4062/#4113) understated the real wall about three times. The live 'Brick - Orange' is 5,320
// triangles full, 2,638 mid today (1,458 once its stored versions are regenerated with #4307's border
// sliding) and 34 far (a hull). An icosphere can only be 20 * 4^level triangles, so the seeded brick
// is 5,120 full, 1,280 mid (level 3, within 12% of the regenerated mid and half the mid on the site
// today) and 80 far. --mid-level 4 seeds a 5,120-triangle mid (no reduction) and --mid-level 2 the old
// 320, to compare against earlier figures.
const withTiers = !args.includes('--no-tiers');
const MID_LEVEL = Number(flag('--mid-level', 3));
const brickMidUrl = withTiers ? await uploadModel('seed-brick-mid.glb', (BOX_SHAPE ? boxGlb(10, 0.5) : icosphereGlb(MID_LEVEL, 0.25)).glb) : null;
const brickFarUrl = withTiers ? await uploadModel('seed-brick-far.glb', (BOX_SHAPE ? boxGlb(1, 0.5) : icosphereGlb(1, 0.25)).glb) : null;
const mkTemplate = async (name, category, modelUrl, dimensions, priceCents, tiers = {}) => (await api('/catalog', builder.cookie, {
  method: 'POST',
  body: JSON.stringify({ name, category, color: '#d98a3a', dimensions, priceCents, sellerId: seller.sellerId, modelUrl, metadata: {}, ...tiers }),
})).template;
const brick = await mkTemplate('Brick - Orange', 'building-materials', brickModelUrl, { width: 0.5, depth: 0.5, height: 0.5 }, 120, { modelMidUrl: brickMidUrl, modelFarUrl: brickFarUrl });

for (let i = 0; i < EXTRA_PRODUCTS; i++) {
  await mkTemplate(`Showroom product ${i + 1}`, 'furniture', brickModelUrl, { width: 0.5, depth: 0.5, height: 0.5 }, 500 + i, { modelMidUrl: brickMidUrl, modelFarUrl: brickFarUrl, modelSizeBytes: glb.byteLength });
}

const mixedFiles = ['crate.glb', 'planter.glb', 'lamp.glb', 'table.glb', 'chair.glb', 'tree.glb', 'bench.glb', 'bookshelf.glb'];
const mixed = [];
for (const file of mixedFiles) {
  const url = await uploadModel(file, await readFile(path.join(repoRoot, 'public', 'models', file)));
  mixed.push(await mkTemplate(file.replace('.glb', ''), 'furniture', url, { width: 1, depth: 1, height: 1 }, 1000));
}

// A wall 55 wide (x), 3 thick (y) and as many courses (z) as the count needs, in the middle of the
// lándlet, then a row of the mixed items in front of it.
const WIDTH = 55; const DEPTH = 3; const STEP = 0.5;
const items = [];
for (let i = 0; i < BRICKS; i++) {
  const col = i % WIDTH; const row = Math.floor(i / WIDTH) % DEPTH; const course = Math.floor(i / (WIDTH * DEPTH));
  items.push({ landletId, templateId: brick.templateId, x: (col - WIDTH / 2) * STEP, y: 4 + row * STEP, z: 0.25 + course * STEP });
}
for (let i = 0; i < 40; i++) {
  items.push({ landletId, templateId: mixed[i % mixed.length].templateId, x: -10 + (i % 20), y: -6 - Math.floor(i / 20) * 2, z: 0 });
}
let placed = 0;
for (let i = 0; i < items.length; i += 100) {
  const { instances } = await api('/instances/batch', builder.cookie, { method: 'POST', body: JSON.stringify({ instances: items.slice(i, i + 100) }) });
  placed += instances.length;
}
console.log(JSON.stringify({ email: builder.email, password: PASSWORD, username: builder.username, landletId, templateId: brick.templateId, brickTriangles: triangles, tiers: withTiers, bricks: BRICKS, placed, extraProducts: EXTRA_PRODUCTS }));
