#!/usr/bin/env node
// #3430 (part of #3428): look at the running site the way a person does. Opens
// the site in the pre-installed Chromium as this session's own account, at the
// owner's phone size by default, runs the steps given on the command line in
// order, and prints one JSON object a session can read: screenshot paths,
// console errors, failed requests, request timings, frame-time figures.
//
//   node scripts/live-site.mjs --name higglehaven10 idle shot:shop walk:forward:3000 fly shot:flying stats
//   node scripts/live-site.mjs --name higglehaven10 --timing /api/credit-orbs mode:shop idle
//   node scripts/live-site.mjs --url http://127.0.0.1:8787 --login local --name higglehaven10 idle shot
//
// Steps (each `name` or `name:arg:arg`):
//   walk:<forward|back|left|right>[:ms]   hold the joystick that way (default 1000 ms)
//   aim:<up|down|left|right>[:ms]        hold the look joystick that way (default 1000 ms):
//                                         turns the camera, up and down are the pitch
//   look:<dx>:<dy>                        drag the page by that many pixels
//   tap:<x>:<y> | tap:<css selector>      tap a point or a named control
//   mode:<shop|build|sell>                switch mode
//   fly                                   toggle flying
//   settings                              open the account menu, then Settings
//   idle                                  wait until the network and frames settle
//   wait:<ms>                             wait
//   shot[:name]                           screenshot at CSS-pixel scale (390x844 on a phone)
//   stats                                 frame figures so far (longest frame, long tasks)
//
// Flags: --url (default https://higglehaven.com), --name (required; this
// session's name), --desktop (1280x800 instead of phone), --login fleet|local,
// --out <dir> (screenshots; use your scratchpad), --timing <substring> (repeat).
//
// Never prints or stores a cookie or a header value. Requests go through the
// session's network proxy (HTTPS_PROXY), which adds the fleet key header; this
// script never sees that value.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PHONE, DESKTOP, WALK_VECTORS, AIM_VECTORS, parseArgs, safeShotName, summarizeTimings, routeOf, durationFromTiming, gateRefusalMessage,
} from './live-site-lib.mjs';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2), process.env);
} catch (error) {
  fail(`live-site: ${error.message}`);
}
const { options, steps } = parsed;
const baseUrl = options.url.replace(/\/$/, '');
const outDir = options.out || path.join(os.tmpdir(), 'live-site');
fs.mkdirSync(outDir, { recursive: true });

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl);
const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
// The session's proxy is what adds the fleet key; a local server is reached directly.
if (!isLocal && process.env.HTTPS_PROXY) launchOptions.proxy = { server: process.env.HTTPS_PROXY };

const device = options.desktop ? DESKTOP : PHONE;
const browser = await chromium.launch(launchOptions);
// Only for a local run against a wrangler dev started with its own throwaway
// FLEET_ACCESS_KEY (the e2e): there is no proxy to add the header. On the live
// site the proxy adds it and this stays unset. Never printed.
const localFleetKey = process.env.LIVE_SITE_FLEET_KEY;
const context = await browser.newContext({
  ...(localFleetKey && isLocal ? { extraHTTPHeaders: { 'x-fleet-key': localFleetKey } } : {}),
  viewport: { width: device.width, height: device.height },
  deviceScaleFactor: device.deviceScaleFactor,
  isMobile: device.isMobile,
  hasTouch: device.hasTouch,
});
const page = await context.newPage();

const result = { url: baseUrl, name: options.name, device: options.desktop ? 'desktop' : 'phone', screenshots: [], consoleErrors: [], failedRequests: [], timings: {}, steps: [] };
const timingSamples = new Map();
page.on('pageerror', (error) => result.consoleErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') result.consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => result.failedRequests.push({ url: routeOf(request.url()), method: request.method(), reason: request.failure()?.errorText || 'failed' }));
page.on('response', (response) => {
  if (response.status() >= 400) result.failedRequests.push({ url: routeOf(response.url()), method: response.request().method(), status: response.status() });
});
page.on('requestfinished', async (request) => {
  const url = request.url();
  if (!options.timing.some((needle) => url.includes(needle))) return;
  const duration = durationFromTiming(request.timing());
  if (duration === null) return;
  const key = `${request.method()} ${routeOf(url)}`;
  if (!timingSamples.has(key)) timingSamples.set(key, []);
  timingSamples.get(key).push(duration);
});

async function signIn() {
  const request = context.request; // shares the browser context's cookie jar; the cookie is never read here
  if (options.login === 'fleet') {
    const response = await request.post(`${baseUrl}/api/auth/fleet-login`, { data: { name: options.name } });
    if (response.status() === 401) fail(`live-site: ${gateRefusalMessage(401)}`);
    if (response.status() === 404) fail('live-site: fleet login answered 404: the fleet key is not accepted here, or fleet login is not deployed yet (#3429).');
    if (!response.ok()) fail(`live-site: fleet login failed with HTTP ${response.status()}.`);
    return;
  }
  // A local wrangler dev instance: an ordinary throwaway account, no mailbox needed.
  const email = `${options.name}@e2e.test`;
  const password = 'live-site-local-password-123';
  const signup = await request.post(`${baseUrl}/api/auth/signup`, { data: { email, password, username: options.name, ageAttested: true } });
  if (signup.ok()) return;
  const login = await request.post(`${baseUrl}/api/auth/login`, { data: { email, password } });
  if (!login.ok()) fail(`live-site: could not sign in locally (signup ${signup.status()}, login ${login.status()}).`);
}

// A throwaway local account has not passed the age and card check; the dev-mode
// verify step clears it. (A fleet account counts as verified, #3429.)
async function clearLocalVerifyModal() {
  const shown = await page.waitForSelector('#verify-modal.visible', { timeout: 8000 }).then(() => true).catch(() => false);
  if (!shown) return;
  const ready = () => page.waitForFunction(() => {
    const modal = document.getElementById('verify-modal');
    return !modal.classList.contains('visible') || !document.getElementById('verify-continue-btn').disabled;
  }, null, { timeout: 60000 });
  if (await page.locator('#verify-age-step').isVisible()) {
    await page.check('#verify-age-attest');
    await page.click('#verify-continue-btn');
    await ready();
  }
  if (await page.locator('#verify-modal.visible').count() > 0) {
    await ready();
    await page.click('#verify-continue-btn');
  }
  await page.waitForSelector('#verify-modal:not(.visible)', { state: 'attached', timeout: 15000 });
  await settle();
}

const frameStats = () => page.evaluate(() => {
  const monitor = window.__frameMonitor;
  return monitor ? { longestFrameMs: Math.round(monitor.longestFrameGapMs()), longTasks: monitor.longTasks() } : null;
});
const settle = async () => {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
};

async function holdJoystick(direction, ms, { selector = '#shop-move-joystick', vectors = WALK_VECTORS } = {}) {
  await page.waitForSelector('#shop-fly-btn.visible', { timeout: 30000 }).catch(() => {});
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error('the joystick is not on screen (is this Shop mode?)');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const [vx, vy] = vectors[direction];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + (vx * box.width) / 2, cy + (vy * box.height) / 2, { steps: 4 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function runStep(step, index) {
  const [a, b] = step.args;
  switch (step.command) {
    case 'walk':
      await holdJoystick(a, b);
      return null;
    case 'aim':
      await holdJoystick(a, b, { selector: '#shop-look-joystick', vectors: AIM_VECTORS });
      return null;
    case 'look': {
      const startX = device.width / 2;
      const startY = device.height / 3;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + a, startY + b, { steps: 8 });
      await page.mouse.up();
      return null;
    }
    case 'tap':
      if (typeof a === 'number') await (device.hasTouch ? page.touchscreen.tap(a, b) : page.mouse.click(a, b));
      else if (device.hasTouch) await page.locator(a).first().tap();
      else await page.locator(a).first().click();
      return null;
    case 'mode':
      await page.click(`.mode-nav-btn[data-mode="${a}"]`);
      await settle();
      return null;
    case 'fly':
      await page.click('#shop-fly-btn');
      return null;
    case 'settings':
      await page.click('#account-menu-toggle');
      await page.click('#settings-btn');
      await page.waitForTimeout(300);
      return null;
    case 'idle':
      await settle();
      return null;
    case 'wait':
      await page.waitForTimeout(a);
      return null;
    case 'shot': {
      const file = path.join(outDir, safeShotName(a, index));
      // scale 'css': one image pixel per CSS pixel, so a phone shot is 390x844 whatever the screen density.
      await page.screenshot({ path: file, scale: 'css' });
      result.screenshots.push(file);
      return file;
    }
    case 'stats':
      return frameStats();
    default:
      throw new Error(`unhandled step ${step.command}`);
  }
}

try {
  await signIn();
  const landing = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  if (landing && landing.status() === 401) fail(`live-site: ${gateRefusalMessage(401)}`);
  await settle();
  if (options.login === 'local') await clearLocalVerifyModal();
  // #3483: what happened before the first step (the title screen and first
  // load), kept apart from the steps' own figures, which start from a reset.
  result.startup = await frameStats().catch(() => null);
  await page.evaluate(() => window.__frameMonitor?.reset()).catch(() => {});
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const label = [step.command, ...step.args].join(':');
    try {
      const value = await runStep(step, i + 1);
      // #3483: when the step ended, in the page's own clock (ms since
      // navigation), the same one `stats.longTasks.longestAtMs` uses, so a
      // reader can tell which step a long task fell in.
      const endedAtMs = await page.evaluate(() => Math.round(performance.now())).catch(() => null);
      result.steps.push({ step: label, ok: true, endedAtMs, ...(value !== null && step.command === 'stats' ? { stats: value } : {}) });
    } catch (error) {
      result.steps.push({ step: label, ok: false, error: error.message.split('\n')[0] });
      break;
    }
  }
  result.frame = await frameStats();
  for (const [key, samples] of timingSamples) result.timings[key] = summarizeTimings(samples);
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.steps.some((s) => !s.ok) ? 2 : 0);
