// #3326 (owner decision "Bundle sharing defaults to public on save"): the Save
// Bundle dialog opens with "Anyone can place this bundle" selected, the other
// option reads "Only you can place this bundle", and the toolbar says Bundle /
// Unbundle (not Group / Ungroup).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Public Default Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(200, 380);
await page.waitForTimeout(800);

const labels = await page.evaluate(() => ({
  bundle: document.getElementById('group-item').textContent.trim(),
  unbundle: document.getElementById('ungroup-item').textContent.trim(),
}));
await page.click('#save-bundle-item');
await page.waitForSelector('#bundle-name-modal.visible', { timeout: 10000 });
const modal = await page.evaluate(() => ({
  publicChecked: document.getElementById('bundle-name-share-public').checked,
  privateChecked: document.getElementById('bundle-name-share-private').checked,
  text: document.getElementById('bundle-name-share-label').textContent,
}));
console.log('toolbar labels / save dialog:', JSON.stringify({ labels, modal }));

const pass = labels.bundle === 'Bundle' && labels.unbundle === 'Unbundle'
  && modal.publicChecked && !modal.privateChecked
  && /Anyone can place this bundle/.test(modal.text) && /Only you can place this bundle/.test(modal.text)
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3326: toolbar says Bundle/Unbundle and the save dialog opens with public selected',
  errors,
});
