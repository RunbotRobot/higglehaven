// #3939 (part of #3939/#3544): an empty Friends leaf has no blank run between its buttons and the one
// friendly line. The leaf is a flex column with a gap, and its status line and four lists are empty
// divs that each added a gap: about 60px of nothing (seen live, 390x844).
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Friends Gap';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
await openAccountMenu(page);
await page.click('#friends-btn');
await page.waitForSelector('#friends-modal.visible', { timeout: 10000 });
await page.waitForSelector('#friends-panel-empty', { state: 'visible', timeout: 10000 });
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const m = await page.evaluate(() => {
  const r = (id) => document.getElementById(id).getBoundingClientRect();
  return { toolbarBottom: document.querySelector('.friends-toolbar').getBoundingClientRect().bottom, emptyTop: r('friends-panel-empty').top };
});
const gap = m.emptyTop - m.toolbarBottom;
console.log('gap between the buttons and the empty line:', Math.round(gap));
check(gap >= 0 && gap <= 28, `the empty line sits close under the buttons (${Math.round(gap)}px apart)`);
await finish(browser, { pass: pass && errors.length === 0, label: 'Empty Friends leaf: no blank gap under the buttons (#3939)', errors });
