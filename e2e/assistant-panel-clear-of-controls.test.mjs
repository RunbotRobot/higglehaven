// #3553 (part of interface week, #3539): the assistant panel, opened with no
// conversation, used to be a full-width sheet over the joysticks, the fly
// button and the up/down arrows, so a person with it open could not walk or
// look. At phone size in Shop it now starts above all of them, flying or not,
// and it can be minimised from the first moment. A real tap on a pixel is not
// automated in this suite, so the panel is opened through the same click
// handler Settings > Ask an assistant uses.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Panel Clear Shopper';
const LANDLET_ID = 'assistant-panel-clear-landlet';

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
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// What the panel overlaps, as a list of the controls it covers.
const covered = () => page.evaluate(() => {
  const panel = document.getElementById('assistant-chat-panel').getBoundingClientRect();
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const hit = [];
  for (const selector of ['#shop-move-joystick', '#shop-look-joystick', '#shop-fly-btn', '#shop-vertical-controls']) {
    const el = document.querySelector(selector);
    if (!el || getComputedStyle(el).display === 'none') continue;
    if (overlaps(panel, el.getBoundingClientRect())) hit.push(selector);
  }
  return { hit, panel: panel.toJSON(), vh: window.innerHeight };
});

// Open the panel with no conversation, the way Settings > Ask an assistant does.
await page.evaluate(() => document.getElementById('settings-assistant-btn').click());
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
await page.click('#shop-fly-btn');
await page.waitForFunction((was) => document.body.classList.contains('shop-flying') !== was, firstState, { timeout: 10000 });
const second = await covered();
check(second.hit.length === 0, `${firstState ? 'on the ground' : 'flying'}: the panel covers no movement control (covers: ${second.hit.join(', ') || 'none'}; panel ${JSON.stringify(second.panel)})`);
check(second.panel.top > 0, 'the panel is still fully on screen');

await page.click('#assistant-chat-minimize');
const tucked = await page.evaluate(() => ({
  panelShown: getComputedStyle(document.getElementById('assistant-chat-panel')).display !== 'none',
  pillShown: !document.getElementById('assistant-chat-pill').hidden,
}));
check(!tucked.panelShown && tucked.pillShown, `minimising with no conversation tucks the panel away and shows the pill (${JSON.stringify(tucked)})`);
await page.click('#assistant-chat-pill');
await page.waitForSelector('#assistant-chat-panel:not(.minimized)', { timeout: 5000 });

await finish(session.browser, { pass, label: '#3553: the assistant panel opens above the joysticks, fly button and arrows, and can be minimised at once', errors: session.errors });
