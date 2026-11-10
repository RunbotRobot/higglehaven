// #3393: the fly button is brand green both while flying and while grounded
// (it used to turn white when grounded); only the icon says which state it is
// in. Shop spawns the player in flight; a tap on the button lands them.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Fly Button Colour Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 844 });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });
await page.waitForSelector('body.shop-flying', { timeout: 20000 });
await page.waitForTimeout(500);

const read = () => page.evaluate(() => {
  const btn = document.getElementById('shop-fly-btn');
  return {
    background: getComputedStyle(btn).backgroundColor,
    icon: document.getElementById('shop-fly-btn-icon').getAttribute('src'),
    green: getComputedStyle(document.documentElement).getPropertyValue('--brand-green').trim(),
  };
});
const flying = await read();
await page.click('#shop-fly-btn');
await page.waitForFunction((src) => document.getElementById('shop-fly-btn-icon').getAttribute('src') !== src, flying.icon, { timeout: 30000 });
await page.waitForTimeout(300);
const grounded = await read();
console.log('flying:', JSON.stringify(flying), '| grounded:', JSON.stringify(grounded));

const toRgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
const green = toRgb(flying.green);
const pass = flying.background === green && grounded.background === green && flying.icon !== grounded.icon && errors.length === 0;
await finish(browser, { pass, label: '#3393: the fly button is brand green in both states and the icon still swaps', errors });
