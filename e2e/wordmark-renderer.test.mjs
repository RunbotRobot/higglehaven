// #3782 (part of #3771): the renderer that draws a lándlet's name in its chosen lettering. In the real app
// shared/wordmark-set.js offers only `default` until the owner picks, so the page hook draws as if every
// candidate were offered. Checks, in a real browser:
//   - the sign in the open menu stays the default look for a stored style the list does not offer;
//   - a candidate face is fetched only when a name asks for it, once however many names ask, off the frame;
//   - the name shows at once, in the fallback, then the face takes over under the same family name;
//   - the name stays real, selectable text, and the colour pair sets ink and the accent bar;
//   - the default draws no hooks and fetches nothing.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Wordmark Renderer';
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
const fontRequests = [];
page.on('request', (req) => { if (req.url().includes('/design-directions/wordmark-fonts/')) fontRequests.push(req.url().split('/').pop()); });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });

// The app's own sign, with a stored style the shared list does not offer: the default look, no face fetched.
await page.evaluate(() => window.__testShowBudPlace({ name: 'Maple lándlet', builder: 'Ana', wordmarkStyle: 'script', wordmarkColors: 'berry' }));
const real = await page.evaluate(() => {
  const el = document.querySelector('#account-menu-landlet-info .bud-place-name');
  return { text: el.textContent, hooks: el.getAttributeNames().filter((n) => n.startsWith('data-wordmark')), style: el.getAttribute('style') };
});
check(real.text === 'Maple lándlet' && real.hooks.length === 0 && !real.style, `an unoffered style draws the default look (${JSON.stringify(real)})`);
check(fontRequests.length === 0, `no face is fetched for the default (${fontRequests})`);

// Every candidate, as if offered, on a scratch element.
const out = await page.evaluate(async () => {
  const stage = document.createElement('div');
  stage.id = 'wm-stage';
  stage.style.cssText = 'position:fixed;left:0;top:0;width:360px;background:#fff;z-index:9999';
  document.body.appendChild(stage);
  const make = () => { const s = document.createElement('span'); s.className = 'bud-place-name'; stage.appendChild(s); return s; };
  const frames = [];
  let last = performance.now();
  let stop = false;
  const tick = (t) => { frames.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  const a = make();
  const before = window.__wordmarkStats();
  window.__testRenderWordmark(a, { name: "Pip's Corner", styleId: 'script', colourId: 'berry' });
  const atOnce = { text: a.textContent, loading: a.dataset.wordmarkLoading, style: a.dataset.wordmark, colour: a.dataset.wordmarkColour, ink: a.style.getPropertyValue('--wm-ink') };
  const second = make(); const third = make();
  window.__testRenderWordmark(second, { name: 'Second', styleId: 'script', colourId: 'sky' });
  window.__testRenderWordmark(third, { name: 'Third', styleId: 'script' });
  await new Promise((resolve) => { const t0 = performance.now(); const poll = () => (a.dataset.wordmarkLoading === undefined || performance.now() - t0 > 8000 ? resolve() : setTimeout(poll, 50)); poll(); });
  stop = true;
  const after = window.__wordmarkStats();
  const cs = getComputedStyle(a);
  const bar = getComputedStyle(a, '::after');
  const faceReady = document.fonts.check('400 20px "WM Script"');
  const selectable = cs.userSelect !== 'none' && cs.pointerEvents !== 'none';
  const barDrawn = bar.content !== 'none' && bar.height === '4px';
  const family = cs.fontFamily; // read before the name is drawn as the default again
  // the default again: bare
  window.__testRenderWordmark(a, { name: "Pip's Corner", styleId: 'default', colourId: 'default' });
  const bare = { hooks: a.getAttributeNames().filter((n) => n.startsWith('data-wordmark')), style: a.getAttribute('style') };
  return { atOnce, requestedBefore: before.requested, requestedAfter: after.requested, loaded: after.loaded, failed: after.failed, loadMs: after.loadMs, family, faceReady, selectable, barDrawn, bare, longestFrameMs: Math.round(Math.max(...frames)) };
});
console.log(JSON.stringify(out));
check(out.atOnce.text === "Pip's Corner" && out.atOnce.loading === 'true' && out.atOnce.style === 'script' && out.atOnce.colour === 'berry', `the name shows at once, marked loading (${JSON.stringify(out.atOnce)})`);
check(out.atOnce.ink === '#8a2450', `the colour pair sets the ink (${out.atOnce.ink})`);
check(out.requestedAfter - out.requestedBefore === 1, `one face fetch for three names in one style (${out.requestedBefore} -> ${out.requestedAfter})`);
check(out.loaded >= 1 && out.failed === 0, `the face loaded (${out.loaded} loaded, ${out.failed} failed)`);
check(out.faceReady && /WM Script/.test(out.family), `the face is registered under its family and the element uses it (${out.family})`);
check(out.selectable, 'the name is selectable');
check(out.barDrawn, 'the accent bar is drawn under a name with a colour pair');
check(out.bare.hooks.length === 0 && !out.bare.style, `drawing the default again removes every hook (${JSON.stringify(out.bare)})`);
check(fontRequests.filter((f) => f.includes('pacifico')).length === 1, `the Script face file was requested once (${fontRequests})`);
console.log(`longest frame while the face loaded: ${out.longestFrameMs} ms (software GL here; reported, not asserted)`);

await finish(browser, { pass, label: 'Wordmark renderer: a lándlet name in its chosen lettering, a face loaded once, off the frame', errors });
