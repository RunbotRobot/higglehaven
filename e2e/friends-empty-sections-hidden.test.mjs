// #3554: a Friends or Notices panel with nothing in it draws no empty
// sections and no actions with nothing to act on. A new account opening
// Friends sees one friendly line and no section headings; Notices shows its
// "Nothing here yet." line and neither Mark all read nor Clear read.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const NAME = 'Empty Sections Suite';
const session = await launchPage({ promptAnswer: NAME });
const page = session.page;
await chooseIdentity(page, { mode: 'build', label: NAME, isNew: true });
await claimLandlet(page);

await openAccountMenu(page);
await page.click('#friends-btn');
await page.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await page.waitForSelector('#friends-panel-empty:not([hidden])', { timeout: 30000 });
const headingsShown = await page.evaluate(() =>
  ['incoming', 'outgoing', 'accepted', 'blocked']
    .map((k) => document.getElementById(`friends-${k}-heading`))
    .filter((el) => el && !el.hidden).length);
const emptyLine = await page.textContent('#friends-panel-empty');
console.log('visible friends section headings (should be 0):', headingsShown);
console.log('panel line:', emptyLine.trim());
await page.click('#friends-close-btn');

await openAccountMenu(page);
await page.click('#notifications-btn');
await page.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await page.waitForSelector('#notifications-empty:not([hidden])', { timeout: 30000 });
const actionsHidden = await page.locator('#notifications-actions').isHidden();
const markHidden = await page.locator('#notifications-mark-all-btn').isHidden();
const clearHidden = await page.locator('#notifications-clear-read-btn').isHidden();
console.log('Notices actions hidden / mark all hidden / clear read hidden (should all be true):', actionsHidden, markHidden, clearHidden);

const pass = headingsShown === 0 && /No friends yet/.test(emptyLine) && actionsHidden && markHidden && clearHidden
  && session.errors.length === 0;
await finish(session.browser, {
  pass,
  label: '#3554: empty Friends sections and empty Notices actions are not drawn',
  errors: session.errors,
});
