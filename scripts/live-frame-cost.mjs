#!/usr/bin/env node
// #3902 / #3403: what Shop asks the GPU to draw each frame, and how long frames take, on the live
// site (or a local server). A frame that costs seconds in headless Chromium is software GL being
// asked for too much: this names the draw call. Wraps the WebGL draw calls with an init script and
// prints, for a few frames spread over the run, the draw calls, triangles (instances counted) and
// the biggest single draw, with the frame time.
//
//   node scripts/live-frame-cost.mjs --name higglehaven10 [--seconds 35] [--url https://...] [--phone] [--max-triangles N]
//   node scripts/live-frame-cost.mjs --url http://127.0.0.1:8787 --email <seeded account> --mode build [--batching off]
//
// #3929: --mode build opens Build instead of Shop and reports a table per phase (entering, standing
// still, orbiting, selecting everything and moving it), against a lándlet seeded by
// scripts/seed-heavy-landlet.mjs. --email signs in as that throwaway local account (password is the
// seed script's) instead of the fleet login, and only works on localhost.
//
// --phone (#3935) slows the CPU 4x and uses a home-wifi phone connection (see PHONE_PROFILE in
// scripts/live-site-lib.mjs) and prints what that profile can and cannot tell: triangles and draw
// calls per frame are the GPU proxy that holds on any machine; the frame time is software GL.
//
// --max-triangles N (#3935) is the budget for the GPU proxy: after the run it prints the most triangles
// any frame asked for and exits 2 when that passes N, so a PR can say "within budget" in one line.
//
// Signs in with the fleet login like scripts/live-site.mjs (the session's proxy adds the fleet key;
// nothing is printed or stored). Standing still at the arrival spot in Shop at 390x844.
import { chromium } from 'playwright';
import { PHONE_PROFILE, applyProfile } from './live-site-lib.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const name = flag('--name', null);
const email = flag('--email', null);
const mode = flag('--mode', 'shop');
if (!['shop', 'build', 'sell'].includes(mode)) { console.error('live-frame-cost: --mode must be shop, build or sell'); process.exit(1); }
if (!email && (!name || !/^higglehaven\d+$/.test(name))) { console.error('live-frame-cost: --name higglehaven<N> is required (this session\'s name), or --email for a local account'); process.exit(1); }
const base = flag('--url', 'https://higglehaven.com').replace(/\/$/, '');
const seconds = Number(flag('--seconds', 35));
const phone = args.includes('--phone');
const maxTriangles = flag('--max-triangles', null);
if (maxTriangles !== null && !(Number(maxTriangles) > 0)) { console.error('live-frame-cost: --max-triangles needs a number above zero'); process.exit(1); }

const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
if (process.env.HTTPS_PROXY && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(base)) launch.proxy = { server: process.env.HTTPS_PROXY };
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base);
if (email && !isLocal) { console.error('live-frame-cost: --email only works against a local server'); process.exit(1); }
const login = email
  ? await context.request.post(`${base}/api/auth/login`, { data: { email, password: process.env.SEED_PASSWORD || 'heavy-landlet-seed-password-123' } })
  : await context.request.post(`${base}/api/auth/fleet-login`, { data: { name } });
if (!login.ok()) { console.error(`live-frame-cost: login answered ${login.status()}`); await browser.close(); process.exit(1); }
if (mode === 'build' || mode === 'sell') await context.addInitScript((m) => { try { sessionStorage.setItem('higglehaven.startMode', m); } catch { /* private window */ } }, mode);
const page = await context.newPage();
if (phone) {
  await applyProfile(await context.newCDPSession(page), PHONE_PROFILE);
  console.log(`Profile: phone (CPU ${PHONE_PROFILE.cpuSlowdown}x slower, ${PHONE_PROFILE.latencyMs} ms, ${PHONE_PROFILE.downKbps / 1000}/${PHONE_PROFILE.upKbps / 1000} Mbps). ${PHONE_PROFILE.limits}`);
} else {
  console.log('Profile: none (a cloud machine: fast CPU, software GL). Add --phone for a phone-like CPU and connection.');
}
await page.addInitScript(() => {
  const state = window.__frameCost = { draws: [], frames: [] };
  const wrap = (proto) => {
    for (const method of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced']) {
      const original = proto[method];
      proto[method] = function (mode, a, b, c, d) {
        let count; let instances = 1;
        if (method === 'drawElements') count = a;
        else if (method === 'drawElementsInstanced') { count = a; instances = d; }
        else if (method === 'drawArrays') count = b;
        else { count = b; instances = c; }
        state.draws.push([mode, count, instances]);
        return original.call(this, mode, a, b, c, d);
      };
    }
  };
  wrap(WebGLRenderingContext.prototype);
  if (window.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype);
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const triangles = state.draws.reduce((sum, [mode, count, instances]) => sum + (mode === 4 ? count / 3 : mode === 5 || mode === 6 ? count - 2 : 0) * instances, 0);
    const biggest = state.draws.reduce((best, d) => (d[1] * d[2] > best[1] * best[2] ? d : best), [0, 0, 1]);
    state.frames.push({ ms: Math.round(now - last), draws: state.draws.length, triangles: Math.round(triangles), biggestDraw: `${biggest[1]} indices x ${biggest[2]} instances` });
    state.draws = [];
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const enteredAt = Date.now();
await page.goto(base, { waitUntil: 'domcontentloaded' });
if (mode === 'build') {
  // Build is ready when every placement of the seeded lándlet has a mesh.
  await page.waitForFunction(() => (window.__testProductPositions?.().length ?? 0) > 100, null, { timeout: 180000 });
  await page.waitForTimeout(2000);
  console.log(`entered Build and built ${await page.evaluate(() => window.__testProductPositions().length)} meshes in ${Math.round((Date.now() - enteredAt) / 1000)} s`);
  // #3929: --batching off draws every item as its own object (src/build/batching.js), for the "before".
  if (flag('--batching', 'on') === 'off') await page.evaluate(() => window.__testSetBuildBatching?.(false));
} else if (mode === 'sell') {
  // #3929: Sell's showroom is ready when every product has a mesh (--products N on the seed).
  const expected = Number(flag('--products', 50));
  await page.waitForFunction((n) => (window.__testSellerShowcaseCount?.() ?? 0) >= n, expected, { timeout: 240000 });
  await page.waitForTimeout(3000);
  console.log(`entered Sell and built ${await page.evaluate(() => window.__testSellerShowcaseCount())} showroom meshes in ${Math.round((Date.now() - enteredAt) / 1000)} s`);
} else {
  await page.waitForSelector('body.shop-ready', { timeout: 60000 });
}

const summarise = (label, frames) => {
  if (!frames.length) return `${label}: no frames`;
  const longest = Math.max(...frames.map((f) => f.ms));
  const worst = frames.reduce((a, f) => (f.triangles > a.triangles ? f : a), frames[0]);
  return `${label}: ${frames.length} frames, longest ${longest} ms, most draws ${Math.max(...frames.map((f) => f.draws))}, most triangles ${worst.triangles}, biggest draw ${worst.biggestDraw}`;
};
const answer = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), 60000))]);
const frameCount = () => answer(page.evaluate(() => window.__frameCost.frames.length));
async function phase(label, run) {
  const from = await frameCount();
  if (from === null) { console.log(`${label}: the page did not answer`); return; }
  await run();
  const frames = await answer(page.evaluate((start) => window.__frameCost.frames.slice(start), from));
  console.log(frames ? summarise(label, frames) : `${label}: the page did not answer for 60 s (main thread stalled)`);
}

if (mode === 'shop') {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const frames = await answer(page.evaluate(() => window.__frameCost.frames));
  if (!frames) {
    console.log('The page did not answer for 60 s after the wait: the main thread is stalled (see the frame cost above, if any).');
  } else {
    const picks = [0.1, 0.3, 0.5, 0.7, 0.9, 1].map((f) => frames[Math.min(frames.length - 1, Math.floor(frames.length * f) - (f === 1 ? 1 : 0))]);
    console.log(`${frames.length} frames in ${seconds} s; longest ${Math.max(...frames.map((f) => f.ms))} ms; most triangles in a frame ${Math.max(...frames.map((f) => f.triangles))}`);
    for (const f of picks) console.log(JSON.stringify(f));
  }
} else if (mode === 'sell') {
  await phase('standing still', () => page.waitForTimeout(Math.min(seconds, 8) * 1000));
} else {
  // The versions of each item are attached over many frames after entering (src/build/lod.js), so
  // wait until nearly every item has them (or --settle seconds, default 300), saying how long it took,
  // then measure the settled state. The wait is the cost of entering Build on a heavy lándlet.
  const settleSeconds = Number(flag('--settle', 300));
  const settleStart = Date.now();
  let lod = null;
  let previousLod = '';
  for (let waited = 0; waited < settleSeconds; waited += 10) {
    await page.waitForTimeout(10000);
    lod = await answer(page.evaluate(() => window.__testBuildLodCounts?.() ?? null));
    const batched = await answer(page.evaluate(() => window.__testBuildBatchCounts?.() ?? null));
    console.log(`  after ${Math.round((Date.now() - settleStart) / 1000)} s: items by version ${JSON.stringify(lod)}, batches ${JSON.stringify(batched)}`);
    // Settled: the same counts twice running (the items beside the orbit target never need versions).
    if (JSON.stringify(lod) === previousLod) break;
    previousLod = JSON.stringify(lod);
  }
  await phase('standing still, settled', () => page.waitForTimeout(Math.min(seconds, 8) * 1000));
  // #3929: orbiting before anything is selected, where the batches draw the wall; the last row below
  // orbits with everything selected, which is every item drawn as itself.
  await phase('orbiting, nothing selected', async () => {
    await page.mouse.move(195, 300);
    await page.mouse.down();
    for (let i = 0; i < 30; i++) { await page.mouse.move(195 + i * 4, 300 + i, { steps: 1 }); await page.waitForTimeout(60); }
    await page.mouse.up();
  });
  await phase('selecting everything', async () => { await page.evaluate(() => window.__testSelectAllProducts?.()); await page.waitForTimeout(3000); });
  await phase('moving the selection up and back', async () => {
    await page.evaluate(() => window.__testDragGroupMoveZ?.(1));
    await page.waitForTimeout(2000);
  });
}
  await phase(mode === 'build' ? 'orbiting, everything selected' : 'orbiting (a drag across the view)', async () => {
    await page.mouse.move(195, 300);
    await page.mouse.down();
    for (let i = 0; i < 30; i++) { await page.mouse.move(195 + i * 4, 300 + i, { steps: 1 }); await page.waitForTimeout(60); }
    await page.mouse.up();
  });
let overBudget = false;
if (maxTriangles !== null) {
  const most = await answer(page.evaluate(() => Math.max(0, ...window.__frameCost.frames.map((f) => f.triangles))));
  if (most === null) { console.log(`budget --max-triangles ${maxTriangles}: no figure (the page did not answer)`); overBudget = true; }
  else { overBudget = most > Number(maxTriangles); console.log(`budget --max-triangles ${maxTriangles}: most triangles in a frame ${most} is ${overBudget ? 'OVER' : 'within'} the limit`); }
}
await browser.close();
if (overBudget) process.exit(2);
