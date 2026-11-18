// #3625: Settings in Build and Sell showed its top behind the Shop/Build/Sell
// buttons (the owner's phone, twice now). The panel is centred in the visible
// screen and scrolls inside itself, so its top edge must never be above the
// mode switch's bottom edge, however tall the tab is and however short the
// screen. This is the test that fails if the next addition to the panel (a
// taller footer, a longer tab) brings it back: the Sell tab is the tallest,
// 390x660 is a phone with the browser bars showing.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Settings Clear Shopper';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function settingsBoxes() {
  return page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect().toJSON();
    return {
      nav: rect(document.getElementById('mode-nav')),
      content: rect(document.getElementById('settings-modal-content')),
      title: rect(document.querySelector('#settings-modal-content h2')),
      close: rect(document.getElementById('settings-close-btn')),
      vh: window.innerHeight,
      maxHeight: getComputedStyle(document.getElementById('settings-modal-content')).maxHeight,
      height: document.getElementById('settings-modal-content').getBoundingClientRect().height,
    };
  });
}

async function checkSettings(mode, label) {
  for (const height of [844, 660]) {
    await page.setViewportSize({ width: 390, height });
    await page.click('#account-menu-toggle');
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal.visible', { timeout: 10000 });
    // #3704: Sell's tab is gone (payouts moved to the bud); the General tab is the tall one now.
    await page.click('.settings-tab-btn[data-section="general"]');
    await page.waitForTimeout(500);
    const box = await settingsBoxes();
    const where = `${label}, ${height} px tall`;
    check(box.content.top >= box.nav.bottom, `${where}: the panel starts below the mode switch (panel top ${Math.round(box.content.top)}, height ${Math.round(box.height)}, max-height ${box.maxHeight}, switch bottom ${Math.round(box.nav.bottom)})`);
    check(box.title.top >= box.nav.bottom && box.close.top >= box.nav.bottom, `${where}: the title and the close control are below the mode switch`);
    check(box.content.bottom <= box.vh, `${where}: the panel ends inside the screen (bottom ${Math.round(box.content.bottom)}, screen ${box.vh})`);
    check(await page.evaluate(() => {
      const content = document.getElementById('settings-modal-content');
      return content.scrollHeight <= content.clientHeight || getComputedStyle(content).overflowY !== 'visible';
    }), `${where}: what does not fit scrolls inside the panel`);
    await page.click('#settings-close-btn');
    await page.waitForSelector('#settings-modal', { state: 'hidden', timeout: 5000 });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
await checkSettings('build', 'Build');

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);
await checkSettings('sell', 'Sell');

await finish(browser, { pass, label: '#3625: Settings starts below the mode switch in Build and Sell, on a tall and a short screen', errors });
