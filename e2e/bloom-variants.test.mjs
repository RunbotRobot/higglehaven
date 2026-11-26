// #4440: behind ?bloom= the flower's head blooms when the menu opens (src/ui/bloom.js). Without the switch nothing
// is added; with it, the drawn petals exist, show only while the menu is open, never take a tap away from a mode
// petal, and the head eases down to the flower's centre and back.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const LABEL = 'Bloom Variants';
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
check(await page.evaluate(() => !document.getElementById('bud-bloom') && !document.body.dataset.bloom), 'with no switch nothing is added');

for (const [variant, count] of [['petals', 9], ['ring', 12], ['sepals', 7]]) {
  await page.goto(`${BASE_URL}/?bloom=${variant}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
  const closed = await page.evaluate(() => {
    const host = document.getElementById('bud-bloom');
    return { there: !!host, petals: host?.children.length, shown: host ? getComputedStyle(host).display : null, bloom: document.body.dataset.bloom };
  });
  check(closed.there && closed.petals === count && closed.shown === 'none' && closed.bloom === variant, `${variant}: ${count} drawn petals, none shown while folded (${JSON.stringify(closed)})`);

  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 10000 });
  await page.waitForTimeout(900);
  const open = await page.evaluate(() => {
    const host = document.getElementById('bud-bloom');
    const petal = host.querySelector('.bloom-petal');
    const logo = document.querySelector('#account-menu-toggle .bud-logo');
    const shop = document.querySelector('#bud-modes .mode-nav-btn[data-mode="shop"]');
    const r = shop.getBoundingClientRect();
    // a point inside the Shop petal, where a drawn petal may lie beneath it: the tap must still reach the mode petal
    const hit = document.elementFromPoint(r.left + r.width * 0.55, r.top + r.height * 0.5);
    return {
      shown: getComputedStyle(host).display,
      pointer: getComputedStyle(host).pointerEvents,
      opacity: getComputedStyle(petal).opacity,
      head: getComputedStyle(logo).transform,
      hitIsShopPetal: !!hit?.closest('.mode-nav-btn[data-mode="shop"]'),
    };
  });
  check(open.shown === 'block' && open.pointer === 'none' && Number(open.opacity) > 0.9, `${variant}: the drawn petals are out and never take a tap (${JSON.stringify(open)})`);
  check(open.head.startsWith('matrix(0.86') , `${variant}: the head eases down to the flower's centre (${open.head})`);
  check(open.hitIsShopPetal, `${variant}: a tap on a mode petal still reaches it`);

  await page.click('#account-menu-toggle');
  await page.waitForFunction(() => !document.querySelector('#account-menu-panel.expanded'), null, { timeout: 10000 });
  await page.waitForTimeout(900);
  const folded = await page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('bud-bloom')).display, head: getComputedStyle(document.querySelector('#account-menu-toggle .bud-logo')).transform }));
  check(folded.shown === 'none' && (folded.head === 'none' || folded.head.startsWith('matrix(1,')), `${variant}: folding puts the petals away and the head back (${JSON.stringify(folded)})`);
}

await finish(browser, { pass, label: 'Bloom: the head blooms behind ?bloom= and folds back; drawn petals never take a tap', errors });
