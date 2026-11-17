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
//   cover                                 how much of the screen the interface covers right now
//                                         (share of the viewport, number of separate elements, the
//                                         largest one); how it is counted is in live-site-lib.mjs
//
// Flags: --url (default https://higglehaven.com), --name (required; this
// session's name), --desktop (1280x800 instead of phone), --login fleet|local,
// --out <dir> (screenshots; use your scratchpad), --timing <substring> (repeat),
// --cover-report (instead of steps: walk a fixed list of states and print one table of how
// much of the screen the interface covers in each; for an interface change's before and after).
//
// Never prints or stores a cookie or a header value. Requests go through the
// session's network proxy (HTTPS_PROXY), which adds the fleet key header; this
// script never sees that value.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PHONE, DESKTOP, WALK_VECTORS, AIM_VECTORS, parseArgs, summariseCover, coverTable, safeShotName, summarizeTimings, routeOf, durationFromTiming, gateRefusalMessage,
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


// #3649: in Shop the Build and Sell buttons are petals of the bud, hidden until it is open;
// in Build and Sell they are still the top row. Click the mode's button wherever it is.
async function clickModeButton(page, mode, timeout) {
  const button = page.locator(`.mode-nav-btn[data-mode="${mode}"]`);
  if (!(await button.isVisible())) await page.click('#account-menu-toggle', timeout ? { timeout } : undefined);
  await button.click(timeout ? { timeout } : undefined);
}

// #3542: the page's own side of `cover`: every visible element that paints something itself,
// as a rectangle, with whether it is a root (no painted ancestor). Self-contained, because
// Playwright serialises it into the page. What counts is explained in live-site-lib.mjs.
const collectInterfaceElements = () => {
  const transparent = (color) => !color || color === 'transparent' || /,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const textRect = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect();
  };
  const mainCanvas = document.getElementById('app');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const found = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el === mainCanvas || el.closest('script, style, noscript, template')) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    // Something fading in or out at under 5% opacity (the title screen leaving) is not covering anything.
    let effectiveOpacity = 1;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) effectiveOpacity *= Number(getComputedStyle(a).opacity);
    if (effectiveOpacity < 0.05) continue;
    const style = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const paintsBox = !transparent(style.backgroundColor) || style.backgroundImage !== 'none'
      || ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(style[`border${side}Width`]) > 0 && !transparent(style[`border${side}Color`]))
      || ['img', 'svg', 'video', 'canvas', 'input', 'textarea', 'select', 'iframe'].includes(tag);
    const paintsText = !paintsBox && hasOwnText(el);
    if (!paintsBox && !paintsText) continue;
    // Solid: it hides what is behind it (a background at least 95% opaque, or something that is
    // not a plain tinted box at all); a pale pane or a dim backdrop only tints it.
    const alpha = (color) => {
      const m = /rgba?\(([^)]*)\)/.exec(color);
      if (!m) return 1;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    const tintedBoxOnly = paintsBox && style.backgroundImage === 'none' && !['img', 'svg', 'video', 'canvas', 'input', 'textarea', 'select', 'iframe'].includes(tag);
    const solid = !tintedBoxOnly || alpha(style.backgroundColor) >= 0.95;
    const r = paintsBox ? el.getBoundingClientRect() : textRect(el);
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    found.push({ el, solid, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  }
  const painted = new Set(found.map((f) => f.el));
  const selectorOf = (el) => {
    if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
    const classes = [...el.classList].slice(0, 2).join('.');
    return classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
  };
  const elements = found.map(({ el, rect, solid }) => {
    let root = true;
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (painted.has(a)) { root = false; break; }
    }
    return { selector: selectorOf(el), rect, root, solid };
  });
  return { viewport: { width: vw, height: vh }, elements };
};
const measureCover = async () => {
  const { viewport, elements } = await page.evaluate(collectInterfaceElements);
  return summariseCover(elements, viewport);
};

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
      await clickModeButton(page, a);
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
    case 'cover':
      return measureCover();
    default:
      throw new Error(`unhandled step ${step.command}`);
  }
}


// #3542: `--cover-report`. A fixed list of states, one row each, printed as a markdown table.
// A state that cannot be reached from here (needs a product in view, an item placed, an
// assistant on shift) is listed as not measured, with the reason, so the gaps are visible.
async function runCoverReport() {
  const rows = [];
  const measure = async (state, action) => {
    try {
      if (action) await action();
      // A mode switch reloads the page: wait for the title splash to be gone, or it is what gets measured.
      await page.waitForFunction(() => {
        const splash = document.getElementById('loading-screen');
        return !splash || splash.classList.contains('loading-screen-hidden') || getComputedStyle(splash).display === 'none';
      }, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(900);
      const cover = await measureCover();
      // One picture per state beside the table, to check the number against what is on screen.
      await page.screenshot({ path: path.join(outDir, safeShotName(`cover-${state}`, rows.length + 1)) }).catch(() => {});
      rows.push({ state, cover });
    } catch (error) {
      rows.push({ state, note: `could not reach it: ${error.message.split('\n')[0]}` });
    }
  };
  await measure('Shop, arrival (flying)');
  await measure('Shop, walking', () => page.click('#shop-fly-btn'));
  await measure('Settings, General tab', async () => {
    await page.click('#account-menu-toggle');
    await page.click('#settings-btn');
    await page.click('.settings-tab-btn[data-section="general"]');
  });
  for (const tab of ['shop', 'build', 'sell']) {
    await measure(`Settings, ${tab[0].toUpperCase()}${tab.slice(1)} tab`, () => page.click(`.settings-tab-btn[data-section="${tab}"]`));
  }
  await page.click('#settings-close-btn').catch(() => {});
  // Switching mode can show the title/loading screen again; measure once it has gone.
  const switchMode = async (mode) => {
    await clickModeButton(page, mode, 8000);
    await settle();
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
  };
  await measure('Build, no landlet (claim sheet)', () => switchMode('build'));
  // The claim sheet sits over the mode buttons; close it to reach the next mode.
  await page.click('#claim-back-btn', { timeout: 3000 }).catch(() => {});
  await measure('Sell, idle', () => switchMode('sell'));
  // #3701: My products is a leaf of the bud; open it from its petal (the old Products button is gone).
  await measure('Sell, My products open', async () => {
    await page.click('#account-menu-toggle');
    await page.click('#bud-petal-sell-my-products');
    await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
  });
  rows.push({ state: 'Shop, a product open', note: 'needs a product in view; not automated' });
  rows.push({ state: 'Build, an item selected', note: 'needs a placed item; not automated' });
  rows.push({ state: 'Assistant panel', note: 'needs an assistant on shift; not automated' });
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  console.log(`Interface cover at ${viewport.width}x${viewport.height} (${options.desktop ? 'desktop' : 'phone'}), ${new Date().toISOString().slice(0, 10)}, ${baseUrl}.`);
  console.log('Share of the screen covered by anything that paints over the 3D view, overlap counted once, translucent surfaces counted by full area.');
  console.log('');
  console.log(coverTable(rows));
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
  if (options.coverReport) {
    await runCoverReport();
    await browser.close();
    process.exit(0);
  }
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const label = [step.command, ...step.args].join(':');
    try {
      const value = await runStep(step, i + 1);
      // #3483: when the step ended, in the page's own clock (ms since
      // navigation), the same one `stats.longTasks.longestAtMs` uses, so a
      // reader can tell which step a long task fell in.
      const endedAtMs = await page.evaluate(() => Math.round(performance.now())).catch(() => null);
      result.steps.push({ step: label, ok: true, endedAtMs, ...(value !== null && step.command === 'stats' ? { stats: value } : {}), ...(step.command === 'cover' ? { cover: value } : {}) });
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
