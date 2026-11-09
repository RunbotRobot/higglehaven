// #3252: the upload wizard used to validate the price only on the Confirm
// Dimensions step, which has no price field, and the price field showed a
// "0.00" placeholder that read as an entered value. The price is now checked
// on the step that has the field (before any file is needed), and the field
// has no placeholder, only a helper line.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Upload Price Step Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

const placeholder = await page.locator('#upload-price').getAttribute('placeholder');
const hint = (await page.locator('#upload-price-hint').textContent()).trim();
console.log('price placeholder (should be none):', placeholder);
console.log('price helper line:', hint);

await page.fill('#upload-name', 'Price Step Product');
await page.click('#upload-submit-btn');
await page.waitForTimeout(300);
const status = (await page.locator('#upload-status').textContent()).trim();
console.log('status with blank price (should ask for a price, not a file):', status);
const stepStillFile = await page.locator('#upload-step-file').isVisible();

await page.fill('#upload-price', 'abc');
await page.click('#upload-submit-btn');
await page.waitForTimeout(300);
const badStatus = (await page.locator('#upload-status').textContent()).trim();
console.log('status with invalid price:', badStatus);

const pass = placeholder === null &&
  hint.includes('0') &&
  status.startsWith('Enter a price') &&
  stepStillFile &&
  badStatus.startsWith('Price must be') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#3252: upload price is validated on the step that has the field, with no placeholder value',
  errors,
});
