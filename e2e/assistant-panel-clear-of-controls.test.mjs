// #3553 (part of interface week, #3539): the assistant panel, opened with no
// conversation, used to be a full-width sheet over the joysticks, the fly
// button and the up/down arrows, so a person with it open could not walk or
// look. At phone size in Shop it now starts above all of them, flying or not,
// and it can be minimised from the first moment. A real tap on a pixel is not
// automated in this suite, so the panel is opened through the same click
// handler Settings > Ask an assistant uses.
import { launchPage, chooseIdentity, openAssistantFromHelp, finish } from './helpers.mjs';

const LABEL = 'Panel Clear Shopper';
const LANDLET_ID = 'assistant-panel-clear-landlet';

// #3608: a stand-in for the visual viewport, whose height a test can change
// without resizing the page -- which is what Android Chrome and iOS Safari do
// when the keyboard opens.
const installFakeVisualViewport = (target) => target.addInitScript(() => {
  const vv = new EventTarget();
  vv.height = window.innerHeight;
  vv.offsetTop = 0;
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  window.__setVisibleHeight = (height) => { vv.height = height; vv.dispatchEvent(new Event('resize')); };
});

const session = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
const page = session.page;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const builder = (await fetchJson('/api/builders/me')).body.builder;
await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Panel Clear Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builder.builderId }),
});
await installFakeVisualViewport(page);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// What the panel overlaps, as a list of the controls it covers.
const covered = () => page.evaluate(() => {
  const panel = document.getElementById('assistant-chat-panel').getBoundingClientRect();
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const hit = [];
  // #3769: the flying arrows are gone; nothing stands on the world but the bud (checked
  // by e2e/bud.test.mjs), so there is no list of controls to cover any more.
  for (const selector of []) {
    const el = document.querySelector(selector);
    if (!el || getComputedStyle(el).display === 'none') continue;
    if (overlaps(panel, el.getBoundingClientRect())) hit.push(selector);
  }
  return { hit, panel: panel.toJSON(), vh: window.innerHeight };
});

// Open the panel with no conversation, the way the "?" leaf's Ask an assistant does.
await openAssistantFromHelp(page);
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
// Shop spawns the person flying above the world, so the first state is usually
// "flying" (arrows showing); one tap of the fly button switches it. Check both.
const isFlying = () => page.evaluate(() => document.body.classList.contains('shop-flying'));
const firstState = await isFlying();
const first = await covered();
check(first.hit.length === 0, `${firstState ? 'flying' : 'on the ground'}: the panel covers no movement control (covers: ${first.hit.join(', ') || 'none'}; panel ${JSON.stringify(first.panel)})`);
check(first.panel.top > 0, 'the panel is fully on screen');

// Minimise is there from the first moment, and the world's controls stay free.
check(await page.isVisible('#assistant-chat-minimize'), 'the minimise control is visible with no conversation open');
const closeBox = await page.evaluate(() => document.getElementById('assistant-chat-close').getBoundingClientRect().toJSON());
const panelBox = first.panel;
check(closeBox.right > panelBox.right - 20 && closeBox.top < panelBox.top + 20, 'the close control stays in the panel\'s upper-right corner');
check(await page.evaluate(() => getComputedStyle(document.getElementById('assistant-chat-log')).userSelect !== 'none'), 'the panel text stays selectable');

// With the panel open the fly button is still tappable (it is not covered), and
// the other state clears the controls too: on the ground there are no arrows,
// in the air they stack above the fly button and the panel starts above them.
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForFunction((was) => document.body.classList.contains('shop-flying') !== was, firstState, { timeout: 10000 });
const second = await covered();
check(second.hit.length === 0, `${firstState ? 'on the ground' : 'flying'}: the panel covers no movement control (covers: ${second.hit.join(', ') || 'none'}; panel ${JSON.stringify(second.panel)})`);
check(second.panel.top > 0, 'the panel is still fully on screen');

// #3608: with the phone keyboard up the viewport is about half as tall. The
// header (title, minimise, close) must stay on screen with the text box
// focused, flying and on the ground; the log is what gives. A shortened
// viewport stands in for the keyboard (the visual-viewport arithmetic itself
// is unit tested).
async function headerOnScreenWithKeyboard(label) {
  await page.setViewportSize({ width: 390, height: 420 });
  await page.focus('#assistant-chat-input');
  await page.waitForTimeout(300);
  const box = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
    return { header: rect('assistant-chat-header'), close: rect('assistant-chat-close'), minimize: rect('assistant-chat-minimize'), input: rect('assistant-chat-input'), vh: window.innerHeight };
  });
  check(box.header.top >= 0 && box.header.bottom <= box.vh, `${label}: the panel's header is on screen with the keyboard up (${JSON.stringify(box.header)}, viewport ${box.vh})`);
  check(box.close.top >= 0 && box.minimize.top >= 0 && box.close.bottom <= box.vh, `${label}: minimise and close are on screen and tappable`);
  check(box.input.bottom <= box.vh, `${label}: the text box is on screen`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);

  // The other way a keyboard shows up: the page keeps its height and only the
  // visible area shrinks. The panel then sits just above the keyboard.
  await page.focus('#assistant-chat-input');
  await page.evaluate(() => window.__setVisibleHeight(420));
  await page.waitForTimeout(300);
  const visual = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
    return { panel: rect('assistant-chat-panel'), header: rect('assistant-chat-header'), input: rect('assistant-chat-input') };
  });
  check(visual.header.top >= 0 && visual.panel.bottom <= 420, `${label}: with only the visible area shrunk to 420, the panel is inside it (panel ${JSON.stringify(visual.panel)})`);
  check(visual.input.bottom <= 420, `${label}: the text box is above the keyboard`);
  await page.evaluate(() => window.__setVisibleHeight(844));
  await page.waitForTimeout(300);
}
await headerOnScreenWithKeyboard(firstState ? 'on the ground' : 'flying');
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForFunction((was) => document.body.classList.contains('shop-flying') !== was, !firstState, { timeout: 10000 });
await headerOnScreenWithKeyboard(firstState ? 'flying' : 'on the ground');

await page.click('#assistant-chat-minimize');
const tucked = await page.evaluate(() => ({
  panelShown: getComputedStyle(document.getElementById('assistant-chat-panel')).display !== 'none',
  pillShown: !document.getElementById('assistant-menu-btn').hidden,
}));
check(!tucked.panelShown && tucked.pillShown, `minimising with no conversation tucks the panel away and shows the Assistant row (${JSON.stringify(tucked)})`);
await page.click('#account-menu-toggle');
await page.click('#assistant-menu-btn');
await page.waitForSelector('#assistant-chat-panel:not(.minimized)', { timeout: 5000 });

await finish(session.browser, { pass, label: '#3553: the assistant panel opens above the joysticks, fly button and arrows, and can be minimised at once', errors: session.errors });
