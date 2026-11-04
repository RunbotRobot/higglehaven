// #3099: removing a Build mode level archives whatever was on it into a saved
// layout server-side (#901), but nothing on screen said so -- the items just
// vanished. Removing a level that holds an item must now say what happened and
// where the items went; removing an empty level stays silent.
import { launchPage, chooseIdentity, claimLandlet, grantLandCapHeadroomAsAdmin, openLevelMenu, finish } from './helpers.mjs';

const LABEL = 'Level Remove Notice Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
const builderId = await page.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));
await grantLandCapHeadroomAsAdmin(builderId);
await openLevelMenu(page);

const status = () => page.textContent('#level-status');

// Empty level: build, then remove straight away.
await page.click('#level-build-btn');
await page.waitForFunction(() => document.querySelector('#level-label')?.textContent === 'Level +1', null, { timeout: 15000 });
await page.click('#level-remove-btn');
await page.waitForFunction(() => document.querySelector('#level-label')?.textContent === 'Ground', null, { timeout: 15000 });
const emptyStatus = await status();
console.log('status after removing an EMPTY level (should be empty):', JSON.stringify(emptyStatus));

// Level holding an item.
await page.click('#level-build-btn');
await page.waitForFunction(() => document.querySelector('#level-label')?.textContent === 'Level +1', null, { timeout: 15000 });
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(1200);
await openLevelMenu(page);
await page.click('#level-remove-btn');
await page.waitForFunction(() => document.querySelector('#level-label')?.textContent === 'Ground', null, { timeout: 15000 });
const sweptStatus = await status();
console.log('status after removing a level holding one item:', JSON.stringify(sweptStatus));

const pass = emptyStatus === '' &&
  sweptStatus.includes('1 item on that level was taken off your land') &&
  sweptStatus.includes('Saved Layouts') &&
  !/#\d+|docs\/|API\.md|swept|snapshot/i.test(sweptStatus) &&
  errors.filter((e) => !e.includes('Failed to load resource')).length === 0;
await finish(browser, { pass, label: 'Removing a level that holds items tells the builder where they went; an empty level stays silent (#3099)', errors });
