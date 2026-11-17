// #3652 (bud leaf 4/9, part of #3648): Settings is a leaf of the bud: a soft sheet that grows
// from the corner the bud lives in, with no dimming scrim (the world shows around it), kept
// inside the screen at a tall and at a short phone, its close control upper right. This is the
// Shop half (the bud's mode); Build and Sell keep #3625's test (settings-clear-of-mode-switch).
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Settings Leaf', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: 'Settings Leaf', isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

for (const height of [844, 660]) {
  await page.setViewportSize({ width: 390, height });
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal.visible', { timeout: 10000 });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect().toJSON();
    const bg = getComputedStyle(document.getElementById('settings-modal')).backgroundColor;
    const alpha = (c) => { const x = c.match(/[\d.]+/g).map(Number); return x.length > 3 ? x[3] : 1; };
    return {
      bud: rect(document.getElementById('account-menu-toggle')),
      content: rect(document.getElementById('settings-modal-content')),
      close: rect(document.getElementById('settings-close-btn')),
      compass: rect(document.getElementById('compass-panel')),
      tabs: rect(document.getElementById('settings-tabs')),
      scrimAlpha: alpha(bg),
      vh: window.innerHeight,
      share: (() => {
        const r = document.getElementById('settings-modal-content').getBoundingClientRect();
        return (r.width * r.height) / (window.innerWidth * window.innerHeight);
      })(),
    };
  });
  const where = `${height}px tall`;
  console.log(where, JSON.stringify({ top: Math.round(m.content.top), left: Math.round(m.content.left), bottom: Math.round(m.content.bottom), scrim: m.scrimAlpha, share: Math.round(m.share * 100) }));
  check(m.scrimAlpha === 0, `${where}: no dimming scrim (alpha ${m.scrimAlpha})`);
  check(m.content.top >= m.bud.bottom, `${where}: the leaf starts under the bud (leaf top ${Math.round(m.content.top)}, bud bottom ${Math.round(m.bud.bottom)})`);
  check(m.content.left < 30, `${where}: the leaf grows from the bud's corner (left ${Math.round(m.content.left)})`);
  check(m.content.bottom <= m.vh && m.content.top >= 0, `${where}: the leaf is inside the screen`);
  check(m.close.left + m.close.width / 2 > m.content.left + m.content.width * 0.75 && m.close.top < m.content.top + 60, `${where}: the close control is upper right of the leaf`);
  check(m.content.right <= m.compass.left, `${where}: the leaf leaves the compass uncovered (leaf right ${Math.round(m.content.right)}, compass left ${Math.round(m.compass.left)})`);
  check(m.tabs.height < 50, `${where}: the four tabs stay on one row (${Math.round(m.tabs.height)}px tall)`);
  check(await page.evaluate(() => {
    const el = document.getElementById('settings-modal-content');
    return el.scrollHeight <= el.clientHeight || getComputedStyle(el).overflowY !== 'visible';
  }), `${where}: what does not fit scrolls inside the leaf`);
  await page.click('#settings-close-btn');
  await page.waitForSelector('#settings-modal', { state: 'hidden', timeout: 5000 });
}
await finish(browser, { pass: pass && errors.length === 0, label: 'settings-leaf (#3652)', errors });
