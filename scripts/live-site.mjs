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
//   walk:<forward|back|left|right>[:ms]   put a finger on the left half of the world and hold it
//                                         dragged that way (default 1000 ms); moving is a
//                                         gesture, no sticks (#3650, #3749)
//   aim:<up|down|left|right>[:ms]         the same from the right half (default 1000 ms): turns
//                                         the camera, up and down are the pitch
//   look:<dx>:<dy>                        drag the page by that many pixels
//   tap:<x>:<y> | tap:<css selector>      tap a point or a named control
//   mode:<shop|build|sell>                switch mode
//   fly                                   double-tap the world: takes off or lands
//   menu                                  open the flower's general menu (does nothing if it is open)
//   petal:<shop|build|sell>               tap that mode's petal (opens the bud first if it is folded)
//   leaf:<notices|friends|purchases|settings|help>
//                                         open the menu if needed, then that leaf (help is the "?"
//                                         petal of Shop and Build)
//   settings                              the same as leaf:settings
//   land                                  land from flight. Every Shop arrival starts in flight 80 m
//                                         up, looking down (docs/SPEC.md #1175), and walking
//                                         forward there descends: a look that wants to walk on the
//                                         ground puts `land` first. Does nothing if already landed.
//   burst:<name>:<count>:<ms>             take <count> stills <ms> apart (numbered files); add
//                                         `:burst:<name>:<count>:<ms>` to the end of any step to take
//                                         them while it runs (walk:forward:2000:burst:walk:4:500 shows
//                                         the walk's legs; tap:... shows a leaf unfolding)
//   slow:<rate>                           run the page's CSS animations at that fraction of their
//                                         speed (slow:0.1 = ten times slower) so a burst catches an
//                                         unfold or a bloom; slow:1 puts them back
//   idle                                  wait until the network and frames settle
//   wait:<ms>                             wait
//   key:<name>                            press one key, e.g. key:KeyN, key:Escape, key:Shift+KeyN
//   shot[:name]                           screenshot at CSS-pixel scale (390x844 on a phone)
//   stats                                 frame figures so far (longest frame, long tasks)
//   pos                                   where the avatar stands now, and which mode and flags the page is in
//   peer:join                             (with --with) the second page's avatar walks up beside this one
//   peer:say:<text> / peer:shot[:name] / peer:pos   the second page speaks in nearby chat / is photographed / reports where it stands
//   cover                                 how much of the screen the interface covers right now
//                                         (share of the viewport, number of separate elements, the
//                                         largest one); how it is counted is in live-site-lib.mjs
//
// Flags: --with <name> (a second signed-in page: a fleet account on the live site, see the peer steps), --url (default https://higglehaven.com), --name (required; this
// session's name), --desktop (1280x800 instead of phone), --size WxH (a touch screen of that size,
// e.g. 844x390 for a phone on its side, 768x1024 for a tablet; #3874), --login fleet|local,
// --out <dir> (screenshots; use your scratchpad), --timing <substring> (repeat),
// --throttle (CPU 4x slower, 150 ms round trip, 1.6/0.75 Mbps: a slow phone, #3736),
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
  PHONE, DESKTOP, WALK_VECTORS, AIM_VECTORS, LEAF_BUTTONS, parseArgs, summariseCover, coverTable, safeShotName, summarizeTimings, routeOf, durationFromTiming, gateRefusalMessage, THROTTLE_PROFILE,
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

const device = options.size || (options.desktop ? DESKTOP : PHONE);
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
const mainPage = page;

const result = { url: baseUrl, name: options.name, device: options.size ? `touch ${options.size.width}x${options.size.height}` : options.desktop ? 'desktop' : 'phone', screenshots: [], consoleErrors: [], failedRequests: [], timings: {}, steps: [] };
if (options.throttle) {
  // Applied after sign-in would miss the sign-in, which is fine; applied here it covers every step.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE_PROFILE.cpuSlowdown });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: THROTTLE_PROFILE.latencyMs, downloadThroughput: THROTTLE_PROFILE.downKbps * 1024 / 8, uploadThroughput: THROTTLE_PROFILE.upKbps * 1024 / 8 });
  result.throttle = THROTTLE_PROFILE;
}
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

async function signIn(ctx = context, name = options.name) {
  const request = ctx.request; // shares the browser context's cookie jar; the cookie is never read here
  if (options.login === 'fleet') {
    const response = await request.post(`${baseUrl}/api/auth/fleet-login`, { data: { name } });
    if (response.status() === 401) fail(`live-site: ${gateRefusalMessage(401)}`);
    if (response.status() === 404) fail('live-site: fleet login answered 404: the fleet key is not accepted here, or fleet login is not deployed yet (#3429).');
    if (!response.ok()) fail(`live-site: fleet login failed with HTTP ${response.status()}.`);
    return;
  }
  // A local wrangler dev instance: an ordinary throwaway account, no mailbox needed.
  const email = `${name}@e2e.test`;
  const password = 'live-site-local-password-123';
  const signup = await request.post(`${baseUrl}/api/auth/signup`, { data: { email, password, username: name, ageAttested: true } });
  if (signup.ok()) return;
  const login = await request.post(`${baseUrl}/api/auth/login`, { data: { email, password } });
  if (!login.ok()) fail(`live-site: could not sign in locally (signup ${signup.status()}, login ${login.status()}).`);
}

// A throwaway local account has not passed the age and card check; the dev-mode
// verify step clears it. (A fleet account counts as verified, #3429.)
async function clearLocalVerifyModal(page = mainPage) {
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
  await settle(page);
}


// #3930 (--with <name>): a second signed-in page, in its own browser context, that stands beside
// the first, so one run can show a tap on a person, a nearby-chat line arriving, or a voice peer in
// the list. Fleet accounts only on the live site (parseArgs). Its console errors are reported
// apart from the first page's.
let peerPage = null;
let peerContext = null;
async function openPeer() {
  peerContext = await browser.newContext({
    ...(localFleetKey && isLocal ? { extraHTTPHeaders: { 'x-fleet-key': localFleetKey } } : {}),
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
  });
  peerPage = await peerContext.newPage();
  result.peer = { name: options.with, consoleErrors: [], failedRequests: [] };
  peerPage.on('pageerror', (error) => result.peer.consoleErrors.push(error.message));
  peerPage.on('console', (message) => {
    if (message.type() === 'error') result.peer.consoleErrors.push(message.text());
  });
  peerPage.on('response', (response) => {
    if (response.status() >= 400) result.peer.failedRequests.push({ url: routeOf(response.url()), method: response.request().method(), status: response.status() });
  });
  await signIn(peerContext, options.with);
  await peerPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await settle(peerPage);
  if (options.login === 'local') await clearLocalVerifyModal(peerPage);
  await peerPage.waitForSelector('body.shop-ready', { timeout: 30000 }).catch(() => {});
}

// peer:join puts the second avatar a few metres beside the first (the page's own test hooks, the
// same ones the e2e suite uses), ends its spawn orbit with a short walk, and asks both pages to
// look for who is nearby; peer:pos / peer:shot read it; peer:say speaks in its nearby chat.
async function runPeerStep(sub, arg, index) {
  if (!peerPage) throw new Error('the second page is not open');
  switch (sub) {
    case 'join': {
      const at = await page.evaluate(() => window.__testShopAvatarPosition?.() ?? null);
      if (!at) throw new Error('the first page has no avatar position yet');
      // A short touch walk ends the spawn orbit, which would otherwise overwrite a teleport.
      const size = peerPage.viewportSize();
      const session = await peerContext.newCDPSession(peerPage);
      const x = Math.round(size.width * 0.25);
      const y = Math.round(size.height * 0.7);
      const send = (type, pts) => session.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
      await send('touchStart', [{ x, y }]);
      await send('touchMove', [{ x, y: y - 60 }]);
      await peerPage.waitForTimeout(400);
      await send('touchEnd', []);
      await peerPage.evaluate(({ x: ax, y: ay, z: az }) => {
        window.__testTeleportShopAvatar?.(ax + 2, ay, az + 2);
        window.__testForceShopProximityCheck?.();
      }, at);
      await page.evaluate(() => window.__testForceShopProximityCheck?.());
      await peerPage.waitForTimeout(1200);
      return runPeerStep('pos', '', index);
    }
    case 'pos':
      return peerPage.evaluate(() => ({ avatar: window.__testShopAvatarPosition?.() ?? null, mode: document.body.dataset.mode, shopReady: document.body.classList.contains('shop-ready') }));
    case 'shot': {
      const file = path.join(outDir, safeShotName(`peer-${arg}`, index));
      await peerPage.screenshot({ path: file, scale: 'css' });
      result.screenshots.push(file);
      return file;
    }
    case 'say': {
      // The Chat petal's leaf holds the nearby-chat form (#3855).
      await peerPage.locator('#account-menu-toggle').click({ timeout: 15000 });
      await peerPage.locator('#bud-petal-shop-chat').click({ timeout: 15000 });
      await peerPage.fill('#shop-nearby-chat-input', arg, { timeout: 15000 });
      await peerPage.press('#shop-nearby-chat-input', 'Enter');
      await peerPage.waitForTimeout(800);
      return null;
    }
    default:
      throw new Error(`unknown peer step ${sub}`);
  }
}

// #3649: in Shop the Build and Sell buttons are petals of the bud, hidden until it is open;
// in Build and Sell they are still the top row. Click the mode's button wherever it is.
async function clickModeButton(page, mode, timeout) {
  const button = page.locator(`.mode-nav-btn[data-mode="${mode}"]`);
  // Whether the bud is open decides, not whether the petal "is visible": a folded petal is only transparent.
  if ((await page.locator('#account-menu-toggle').getAttribute('aria-expanded')) !== 'true') {
    await press(page.locator('#account-menu-toggle'));
    await page.waitForTimeout(700);
  }
  await press(button);
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
const settle = async (page = mainPage) => {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  // The opening screen can still be up when the network goes quiet (a mode switch returns while
  // "Loading the world" is half way), and a shot taken then shows the loading screen, not the
  // thing asked for (seen on #3577). Wait for it to lift; a failed screen stays up on purpose,
  // so it ends the wait, and a stuck one gives up after 30 s rather than hanging the run.
  await page.waitForFunction(() => {
    const splash = document.getElementById('loading-screen');
    return !splash || splash.classList.contains('loading-screen-hidden')
      || splash.classList.contains('loading-screen-failed') || getComputedStyle(splash).display === 'none';
  }, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
};

// #3650: moving is touching the world, so these send real touch events (Chrome
// DevTools Protocol), the same input a phone sends. A walk is one finger dragged
// from the left half of the screen; a look is one finger dragged from the right half
// (#3749: the half it lands on decides, so each works alone); a fly is two quick taps.
let touchSession = null;
let animationSession = null;
async function sendTouch(type, points) {
  touchSession ||= await page.context().newCDPSession(page);
  await touchSession.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}
async function holdWalk(direction, ms) {
  await page.waitForSelector('body.shop-ready', { timeout: 30000 }).catch(() => {});
  const [vx, vy] = WALK_VECTORS[direction];
  const x0 = device.width * 0.25;
  const y0 = device.height * 0.65;
  await sendTouch('touchStart', [{ id: 1, x: x0, y: y0 }]);
  await sendTouch('touchMove', [{ id: 1, x: x0 + vx * 30, y: y0 + vy * 30 }]);
  await sendTouch('touchMove', [{ id: 1, x: x0 + vx * 60, y: y0 + vy * 60 }]);
  await page.waitForTimeout(ms);
  await sendTouch('touchEnd', []);
}
async function holdLook(direction, ms) {
  await page.waitForSelector('body.shop-ready', { timeout: 30000 }).catch(() => {});
  const [vx, vy] = AIM_VECTORS[direction];
  const x0 = device.width * 0.65;
  const y0 = device.height * 0.65;
  await sendTouch('touchStart', [{ id: 1, x: x0, y: y0 }]);
  await sendTouch('touchMove', [{ id: 1, x: x0 + vx * 30, y: y0 + vy * 30 }]);
  await sendTouch('touchMove', [{ id: 1, x: x0 + vx * 60, y: y0 + vy * 60 }]);
  await page.waitForTimeout(ms);
  await sendTouch('touchEnd', []);
}
async function doubleTapWorld() {
  const x = device.width / 2;
  const y = device.height * 0.3;
  touchSession ||= await page.context().newCDPSession(page);
  // Sent back to back, not awaited one by one, so the gap is the page's and a
  // slow round trip cannot stretch it past the double-tap window.
  await Promise.all([
    sendTouch('touchStart', [{ id: 1, x, y }]), sendTouch('touchEnd', []),
    sendTouch('touchStart', [{ id: 1, x, y }]), sendTouch('touchEnd', []),
  ]);
}

// #3817: a control a step needs and cannot find is one plain line naming the step, within 40 s,
// not a 30 s wait that ends the run with a message about a selector nobody typed.
const CONTROL_WAIT_MS = 40000;
// The first control step of a run waits for the app to have finished opening (the menu button is
// the first piece of interface to appear), which on a slow load takes far longer than that.
let appOpened = false;
async function waitForAppOpen() {
  if (appOpened) return;
  try {
    await page.locator('#account-menu-toggle').waitFor({ state: 'visible', timeout: 45000 });
  } catch {
    throw new Error('the app had not finished opening after 45 s (the menu button never appeared)');
  }
  // While the world is still loading, a slow phone's frames take seconds and a tap's checks hang
  // (Playwright waits on frames): go on once four frames in a row arrive within 500 ms of each other, or after 60 s.
  await page.evaluate(() => new Promise((resolve) => {
    let quick = 0;
    let last = performance.now();
    const tick = (now) => {
      quick = now - last < 500 ? quick + 1 : 0;
      last = now;
      if (quick >= 4) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(resolve, 60000);
  })).catch(() => {});
  appOpened = true;
}
async function controlOrFail(selector, what) {
  await waitForAppOpen();
  const control = page.locator(selector).first();
  try {
    await control.waitFor({ state: 'visible', timeout: CONTROL_WAIT_MS });
  } catch {
    throw new Error(`${what} is not on screen after ${CONTROL_WAIT_MS / 1000} s${what.includes(selector) ? '' : ` (${selector})`}`);
  }
  return control;
}
// A touch (or click) at the control's centre, sent straight to the page like a finger: Playwright's own
// tap waits for stable frames first, which a slow phone's loading world can starve for tens of seconds.
async function press(control) {
  const box = await control.boundingBox({ timeout: CONTROL_WAIT_MS });
  if (!box) throw new Error('the control has no place on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (device.hasTouch) {
    await sendTouch('touchStart', [{ id: 1, x, y }]);
    await sendTouch('touchEnd', []);
  } else await page.mouse.click(x, y);
}
async function menuIsOpen() {
  return (await page.locator('#account-menu-toggle').getAttribute('aria-expanded')) === 'true';
}
async function ensureMenuOpen() {
  if (await menuIsOpen()) return;
  // A press that lands while the petals are still folding back after a mode loads can be swallowed,
  // so a second press is made before giving up.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // A first press that opened the menu late (a long frame on a slow machine) must not be answered with a
    // second press, which would close it again: look once more before pressing twice.
    if (attempt === 2 && await menuIsOpen()) {
      await page.waitForTimeout(600);
      return;
    }
    await press(await controlOrFail('#account-menu-toggle', 'the menu button'));
    const opened = await page.waitForFunction(() => document.getElementById('account-menu-toggle')?.getAttribute('aria-expanded') === 'true', null, { timeout: attempt === 1 ? 4000 : CONTROL_WAIT_MS })
      .then(() => true, () => false);
    if (opened) {
      await page.waitForTimeout(600);
      return;
    }
  }
  throw new Error('the menu did not open when its button was pressed');
}
async function closeOpenLeaf() {
  if (!(await page.locator('.bud-leaf').count())) return;
  await press(await controlOrFail('.bud-leaf .bud-leaf-close', 'the open leaf\'s close button'));
  await page.waitForFunction(() => !document.querySelector('.bud-leaf'), null, { timeout: 5000 })
    .catch(() => { throw new Error('the open leaf did not close when its close button was pressed'); });
  await page.waitForTimeout(400);
}
async function takeBurst({ name, count, ms }, index) {
  const files = [];
  for (let k = 1; k <= count; k += 1) {
    const started = Date.now();
    const file = path.join(outDir, safeShotName(`${name}-${k}`, index));
    await page.screenshot({ path: file, scale: 'css' });
    result.screenshots.push(file);
    files.push(file);
    if (k < count) await page.waitForTimeout(Math.max(0, ms - (Date.now() - started)));
  }
  return files;
}

// A step with `:burst:` runs its action and the stills together.
async function runStep(step, index) {
  if (!step.burst) return runStepAction(step, index);
  const [value] = await Promise.all([runStepAction(step, index), takeBurst(step.burst, index)]);
  return value;
}

async function runStepAction(step, index) {
  const [a, b] = step.args;
  switch (step.command) {
    case 'peer':
      return runPeerStep(a, b, index);
    case 'menu':
      await ensureMenuOpen();
      return null;
    case 'petal':
      await waitForAppOpen();
      try {
        await clickModeButton(page, a, CONTROL_WAIT_MS);
      } catch (error) {
        throw new Error(`the ${a} petal could not be pressed within ${CONTROL_WAIT_MS / 1000} s: ${String(error.message).split('\n')[0]}`);
      }
      await settle(); // like `mode`: a petal for another mode loads it, and the shot should not catch the loading screen
      return null;
    case 'leaf':
      await closeOpenLeaf(); // a leaf already open covers the stem, so the next leaf's button could not be pressed and the step would pass over the old leaf
      await ensureMenuOpen();
      await press(await controlOrFail(LEAF_BUTTONS[a], `the ${a} leaf`));
      await page.waitForTimeout(400);
      return null;
    case 'land':
      if (!(await page.evaluate(() => document.body.classList.contains('shop-flying')))) return null;
      await doubleTapWorld();
      await page.waitForFunction(() => !document.body.classList.contains('shop-flying'), null, { timeout: 20000 })
        .catch(() => { throw new Error('still flying 20 s after a double tap on the world'); });
      // The flag clears when the descent starts; the avatar is down when its height stops changing.
      {
        let last = null;
        const deadline = Date.now() + 45000;
        for (;;) {
          const z = await page.evaluate(() => window.__testShopAvatarPosition?.()?.z ?? null);
          if (z !== null && last !== null && Math.abs(z - last) < 0.05) break;
          if (Date.now() > deadline) throw new Error('the avatar was still descending 45 s after landing began');
          last = z;
          await page.waitForTimeout(500);
        }
      }
      return null;
    case 'burst':
      return takeBurst({ name: a, count: b, ms: step.args[2] }, index);
    case 'walk':
      await holdWalk(a, b);
      return null;
    case 'aim':
      await holdLook(a, b);
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
      else await press(await controlOrFail(a, `"${a}"`));
      return null;
    case 'mode':
      await clickModeButton(page, a);
      await settle();
      return null;
    case 'fly':
      await doubleTapWorld();
      return null;
    case 'settings':
      await ensureMenuOpen();
      await press(await controlOrFail(LEAF_BUTTONS.settings, 'the settings leaf'));
      await page.waitForTimeout(400);
      return null;
    case 'idle':
      await settle();
      return null;
    case 'wait':
      await page.waitForTimeout(a);
      return null;
    case 'slow': {
      // Chrome's own animation clock, so CSS animations and transitions run slower and a still
      // every few hundred ms can show a leaf unfolding (#3876). slow:1 restores it.
      animationSession ||= await page.context().newCDPSession(page);
      await animationSession.send('Animation.enable');
      await animationSession.send('Animation.setPlaybackRate', { playbackRate: a });
      return null;
    }
    case 'key':
      // A real key press (a Playwright key name: KeyN, Escape, Shift+KeyN), for the keyboard ways
      // in (#3824). The page's own handlers see an ordinary keydown.
      await page.keyboard.press(String(a));
      await page.waitForTimeout(400);
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
    case 'pos':
      return page.evaluate(() => ({
        avatar: window.__testShopAvatarPosition?.() ?? null,
        mode: document.body.dataset.mode,
        shopReady: document.body.classList.contains('shop-ready'),
        flying: document.body.classList.contains('shop-flying'),
        sellWorldView: window.__sellWorldViewActive?.() ?? null,
        sellBounds: window.__sellWorldGroundBounds?.() ?? null,
      }));
    case 'cover':
      return measureCover();
    case 'marks':
      // #3873: where the time went in this document's life (after a mode switch, the reload that
      // switch caused): the app's own start-up marks and the slowest requests, all in ms since
      // navigation start.
      return page.evaluate(() => {
        const marks = Object.fromEntries(performance.getEntriesByType('mark')
          .filter((m) => m.name.startsWith('hh:')).map((m) => [m.name.slice(3), Math.round(m.startTime)]));
        const nav = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        const slowest = resources.slice().sort((x, y) => y.duration - x.duration).slice(0, 8)
          .map((r) => ({ url: r.name.replace(location.origin, ''), startMs: Math.round(r.startTime), durationMs: Math.round(r.duration), kb: Math.round((r.transferSize || 0) / 1024) }));
        return {
          marks,
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadMs: nav ? Math.round(nav.loadEventEnd) : null,
          requests: resources.length,
          transferKb: Math.round(resources.reduce((n, r) => n + (r.transferSize || 0), 0) / 1024),
          slowest,
        };
      });
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
  await measure('Shop, walking', () => doubleTapWorld());
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
  console.log(`Interface cover at ${viewport.width}x${viewport.height} (${options.size ? 'touch' : options.desktop ? 'desktop' : 'phone'}), ${new Date().toISOString().slice(0, 10)}, ${baseUrl}.`);
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
  if (options.with) await openPeer();
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
    const label = [step.command, ...step.args].join(':').replace(/:+$/, '');
    try {
      const value = await runStep(step, i + 1);
      // #3483: when the step ended, in the page's own clock (ms since
      // navigation), the same one `stats.longTasks.longestAtMs` uses, so a
      // reader can tell which step a long task fell in.
      const endedAtMs = await page.evaluate(() => Math.round(performance.now())).catch(() => null);
      result.steps.push({ step: label, ok: true, endedAtMs, ...(value !== null && step.command === 'stats' ? { stats: value } : {}), ...(step.command === 'cover' ? { cover: value } : {}), ...(step.command === 'pos' ? { pos: value } : {}), ...(step.command === 'peer' && ['pos', 'join'].includes(step.args[0]) ? { pos: value } : {}), ...(step.command === 'marks' ? { marks: value } : {}) });
    } catch (error) {
      // #3817: one plain line naming the step, on the screen as well as in the report.
      const line = `step "${label}" failed: ${error.message.split('\n')[0]}`;
      console.error(`live-site: ${line}`);
      result.steps.push({ step: label, ok: false, error: line });
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
