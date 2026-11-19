#!/usr/bin/env node
// #3902 / #3403: what Shop asks the GPU to draw each frame, and how long frames take, on the live
// site (or a local server). A frame that costs seconds in headless Chromium is software GL being
// asked for too much: this names the draw call. Wraps the WebGL draw calls with an init script and
// prints, for a few frames spread over the run, the draw calls, triangles (instances counted) and
// the biggest single draw, with the frame time.
//
//   node scripts/live-frame-cost.mjs --name higglehaven10 [--seconds 35] [--url https://...]
//
// Signs in with the fleet login like scripts/live-site.mjs (the session's proxy adds the fleet key;
// nothing is printed or stored). Standing still at the arrival spot in Shop at 390x844.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const name = flag('--name', null);
if (!name || !/^higglehaven\d+$/.test(name)) { console.error('live-frame-cost: --name higglehaven<N> is required (this session\'s name)'); process.exit(1); }
const base = flag('--url', 'https://higglehaven.com').replace(/\/$/, '');
const seconds = Number(flag('--seconds', 35));

const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
if (process.env.HTTPS_PROXY && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(base)) launch.proxy = { server: process.env.HTTPS_PROXY };
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const login = await context.request.post(`${base}/api/auth/fleet-login`, { data: { name } });
if (!login.ok()) { console.error(`live-frame-cost: fleet login answered ${login.status()}`); await browser.close(); process.exit(1); }
const page = await context.newPage();
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
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('body.shop-ready', { timeout: 60000 });
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const frames = await Promise.race([page.evaluate(() => window.__frameCost.frames), new Promise((resolve) => setTimeout(() => resolve(null), 60000))]);
if (!frames) {
  console.log('The page did not answer for 60 s after the wait: the main thread is stalled (see the frame cost above, if any).');
} else {
  const picks = [0.1, 0.3, 0.5, 0.7, 0.9, 1].map((f) => frames[Math.min(frames.length - 1, Math.floor(frames.length * f) - (f === 1 ? 1 : 0))]);
  console.log(`${frames.length} frames in ${seconds} s; longest ${Math.max(...frames.map((f) => f.ms))} ms; most triangles in a frame ${Math.max(...frames.map((f) => f.triangles))}`);
  for (const f of picks) console.log(JSON.stringify(f));
}
await browser.close();
