// #3586 (interface week): in Sell, Upload Model, Sell This Too, the delete
// confirmation and Settings all open from My products. Each used to leave
// My products drawn underneath a translucent sheet, so its heading and rows
// read through the new one. One sheet at a time now: My products is hidden
// while any of them is open and comes back, unchanged, when it closes.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'One Sheet Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

const sellerHidden = () => page.evaluate(() => getComputedStyle(document.getElementById('seller-modal')).visibility === 'hidden');
const results = {};

results.startsVisible = !(await sellerHidden());

// Upload Model.
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
results.hiddenUnderUpload = await sellerHidden();
await page.click('#upload-cancel-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 10000 });
results.backAfterUpload = !(await sellerHidden());

// Sell This Too.
await page.click('#sell-this-too-btn');
await page.waitForSelector('#sell-this-too-modal.visible', { timeout: 10000 });
results.hiddenUnderSellThisToo = await sellerHidden();
await page.click('#sell-this-too-close-btn');
await page.waitForFunction(() => !document.getElementById('sell-this-too-modal').classList.contains('visible'), null, { timeout: 10000 });
results.backAfterSellThisToo = !(await sellerHidden());

// Settings.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 10000 });
results.hiddenUnderSettings = await sellerHidden();
await page.click('#settings-close-btn');
await page.waitForFunction(() => !document.getElementById('settings-modal').classList.contains('visible'), null, { timeout: 10000 });
results.backAfterSettings = !(await sellerHidden());

// The delete confirmation is the shared confirm modal; it is driven by the
// same class, so this checks the rule (the delete flow itself is covered by
// the existing delete tests) and that the confirmation is never the thing
// that gets hidden.
await page.evaluate(() => document.getElementById('confirm-modal').classList.add('visible'));
await page.waitForTimeout(100);
results.hiddenUnderConfirm = await sellerHidden();
results.confirmStaysVisible = await page.evaluate(() => getComputedStyle(document.getElementById('confirm-modal')).visibility === 'visible');
await page.evaluate(() => document.getElementById('confirm-modal').classList.remove('visible'));
await page.waitForTimeout(100);
results.backAfterConfirm = !(await sellerHidden());

console.log(JSON.stringify(results));
await finish(browser, {
  pass: Object.values(results).every(Boolean),
  label: '#3586: My products is hidden while Upload, Sell This Too, Settings or a confirmation is open, and returns when it closes',
  errors,
});
