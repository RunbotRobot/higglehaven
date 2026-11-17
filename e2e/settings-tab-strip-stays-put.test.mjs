// #3677: the Settings card used to be centred and sized to its tab, so the tab
// strip moved by up to 230 px when a person switched tabs and the next tap
// landed somewhere else. The strip must stay at the same place on every tab.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Settings Tab Strip Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
await page.click('#account-menu-toggle');
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 10000 });

const tops = {};
for (const section of ['general', 'shop', 'build', 'sell']) {
  await page.click(`.settings-tab-btn[data-section="${section}"]`);
  await page.waitForTimeout(400);
  tops[section] = await page.evaluate(() => Math.round(document.getElementById('settings-tabs').getBoundingClientRect().top));
}
const values = Object.values(tops);
check(Math.max(...values) - Math.min(...values) <= 1, `the tab strip stays at one height on every tab (${JSON.stringify(tops)})`);

await finish(browser, { pass, label: '#3677: Settings tab strip does not move between tabs', errors });
