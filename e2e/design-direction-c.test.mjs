// #3602 (part of #3540, interface week #3539): the "direction C, one bud" mock-up page at
// /design-directions/c.html. It is a mock-up the owner opens on their phone to choose a direction,
// so it has to load clean under the site's CSP, show its three moments over real pictures of the
// world, open and close the bud, and keep its promise of how little of the screen it covers.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });
await page.goto(new URL('/design-directions/c.html', page.url()).toString(), { waitUntil: 'networkidle' });
await page.waitForSelector('#bud');

const state = () => page.evaluate(() => {
  const stage = document.getElementById('stage');
  const world = document.getElementById('world');
  const visible = (id) => {
    const el = document.getElementById(id);
    return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  };
  return {
    moment: stage.dataset.moment,
    open: stage.dataset.open,
    expanded: document.getElementById('bud').getAttribute('aria-expanded'),
    worldLoaded: world.complete && world.naturalWidth > 0,
    stageWidth: Math.round(stage.getBoundingClientRect().width),
    stageHeight: Math.round(stage.getBoundingClientRect().height),
    bloom: visible('product-bloom'),
    leaf: visible('settings-leaf'),
    cover: window.__coverShare(),
    petals: document.querySelectorAll('.petal').length,
  };
});
const settle = () => page.waitForTimeout(900);
const press = (selector) => page.click(selector, { force: true }); // the bud breathes forever, so it is never "stable"

const rows = {};

// Moment 1: walking, nothing open. Let the hint fade first: this is the screen at rest.
await page.waitForTimeout(7000);
rows.walk = await state();

await press('#bud');
await settle();
rows.walkOpen = await state();
await page.keyboard.press('Escape');
await settle();
rows.afterEscape = await state();

// Moment 2: tapping the product itself blooms its card.
await press('#product-hotspot');
await settle();
rows.product = await state();
const buyText = await page.textContent('#buy-btn');

// Moment 3: Settings.
await press('.moment-btn[data-moment="settings"]');
await settle();
rows.settings = await state();
const settingsHeading = await page.textContent('#settings-leaf h2');

// Tapping the world puts everything away.
await page.locator('#stage').click({ position: { x: 60, y: 120 }, force: true });
await settle();
rows.afterWorldTap = await state();

console.log(JSON.stringify(rows, null, 1));

const pass = rows.walk.worldLoaded && rows.product.worldLoaded && rows.settings.worldLoaded
  && rows.walk.stageWidth === 390 && rows.walk.stageHeight === 844
  && rows.walk.moment === 'walk' && rows.walk.open === 'false' && !rows.walk.bloom && !rows.walk.leaf
  && rows.walk.cover < 3
  && rows.walkOpen.open === 'true' && rows.walkOpen.expanded === 'true' && rows.walkOpen.petals === 5
  && rows.walkOpen.cover < 15
  && rows.afterEscape.open === 'false' && rows.afterEscape.expanded === 'false'
  && rows.product.moment === 'product' && rows.product.bloom && !rows.product.leaf
  && buyText.trim() === 'Buy'
  && rows.product.cover < 15
  && rows.settings.moment === 'settings' && rows.settings.leaf && !rows.settings.bloom
  && settingsHeading.trim() === 'Settings'
  && rows.settings.cover < 35
  && rows.afterWorldTap.moment === 'walk' && !rows.afterWorldTap.bloom && !rows.afterWorldTap.leaf
  && errors.length === 0;
await finish(browser, { pass, label: 'design-direction-c (#3602)', errors });
