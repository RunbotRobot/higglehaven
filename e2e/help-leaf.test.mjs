// #3762 (the flower, 3/5; part of #3759): "?" replaces "How to move". At 390x844, in Shop, Build and
// Sell: the bud has a "?" petal; it opens a leaf listing How to move, How higglehaven works, Shopping,
// Building, Selling, Tips and Ask an assistant; a page opens to a few questions that open to their steps, with
// the handbook's own words; Back returns to the list; Ask an assistant opens the assistant window; and
// Settings no longer has an Ask an assistant button.
import { launchPage, chooseIdentity, goToMode, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Help Leaf';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });

async function openHelp() {
  await openAccountMenu(page);
  await page.locator('#account-menu-panel button:visible', { hasText: /^\?$/ }).first().click();
  await page.waitForSelector('#bud-leaf-help', { timeout: 5000 });
}

// Shop: the list.
await openHelp();
const rows = await page.$$eval('#bud-leaf-help .help-row', (els) => els.map((el) => el.textContent.trim()));
console.log('rows:', JSON.stringify(rows));
const noOldPetal = (await page.locator('#account-menu-panel button', { hasText: 'How to move' }).count()) === 0;

// A page: Shopping, whose first question opens to numbered steps taken from the handbook.
await page.click('#bud-leaf-help [data-help-page="shopping"]');
await page.waitForSelector('#bud-leaf-help .help-entry', { timeout: 10000 });
const entries = await page.$$eval('#bud-leaf-help .help-entry summary', (els) => els.map((el) => el.textContent.trim()));
await page.click('#bud-leaf-help .help-entry summary');
const stepCount = await page.locator('#bud-leaf-help .help-entry[open] .help-steps li').count();
console.log('shopping questions:', entries.length, 'steps in the first:', stepCount);

// Tips: every tip the opening screen shows, readable here.
await page.click('#bud-leaf-help .help-back');
await page.waitForSelector('#bud-leaf-help .help-list');
await page.click('#bud-leaf-help [data-help-page="tips"]');
await page.waitForSelector('#bud-leaf-help .help-tips li', { timeout: 5000 });
const tipLines = await page.$$eval('#bud-leaf-help .help-tips li', (els) => els.map((el) => el.textContent.trim()));
console.log('tips on the page:', tipLines.length);

// Back returns to the list; the single-entry page opens its entry itself.
await page.click('#bud-leaf-help .help-back');
await page.waitForSelector('#bud-leaf-help .help-list');
await page.click('#bud-leaf-help [data-help-page="works"]');
await page.waitForSelector('#bud-leaf-help .help-entry[open]', { timeout: 10000 });

// Ask an assistant opens the window and closes the leaf.
await page.click('#bud-leaf-help .help-back');
await page.click('#help-ask-assistant-btn');
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
const leafGone = (await page.locator('#bud-leaf-help').count()) === 0;

// Settings has no Ask an assistant button any more.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
const settingsAskGone = (await page.locator('#settings-assistant-btn').count()) === 0;
await page.click('#settings-close-btn');

// The same petal in Build and in Sell. A new account is asked to claim a lándlet on entering Build,
// and that sheet covers the bud, so Build is checked by the petal being registered (the Build
// controls' own tests walk the bud); Sell shows it.
const perMode = {};
await goToMode(page, 'sell', { openProducts: false });
await page.waitForSelector('body[data-mode="sell"][data-bud="on"]', { timeout: 30000 });
await openAccountMenu(page);
perMode.sell = await page.locator('#account-menu-panel button:visible', { hasText: /^\?$/ }).first().isVisible();
await page.keyboard.press('Escape');
await goToMode(page, 'build', { openProducts: false });
await page.waitForSelector('body[data-mode="build"][data-bud="on"]', { timeout: 30000 });
perMode.build = (await page.locator('#bud-petal-general-help').count()) === 1 && !(await page.locator('#bud-petal-build-help').count()); // #3760: one general petal, registered once
console.log('"?" petal in Build and Sell:', JSON.stringify(perMode));

const pass = JSON.stringify(rows) === JSON.stringify(['How to move', 'How higglehaven works', 'Shopping', 'Building', 'Selling', 'Tips', 'Ask an assistant'])
  && tipLines.length >= 4 && noOldPetal && entries.length >= 4 && stepCount >= 2 && leafGone && settingsAskGone
  && perMode.build && perMode.sell && errors.length === 0;
await finish(browser, { pass, label: '"?" leaf: pages from the handbook, Ask an assistant, in every mode (#3762)', errors });
