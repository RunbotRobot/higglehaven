// #2343: the upload wizard's product name input had no maxlength even
// though the server caps it at 100 characters (validateTemplate's own
// labelValue() call, worker/index.js) -- unlike its sibling price field,
// which already mirrors its own server-side MAX_MONEY_CENTS ceiling
// (#2330). A 101+ character name used to pass client validation and only
// then hit the raw server error text. This is pure client-side (the
// browser itself enforces maxlength, truncating keystrokes past the
// limit), so no upload/network round trip is needed to prove the fix.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Upload Name Maxlength Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

const nameInput = page.locator('#upload-name');
const maxlengthAttr = await nameInput.getAttribute('maxlength');
console.log('upload-name has a maxlength attribute matching the server cap (should be "100"):', maxlengthAttr);

const overLimitName = 'x'.repeat(150);
await nameInput.fill(overLimitName);
const valueAfterFill = await nameInput.inputValue();
console.log('browser-enforced value length after filling 150 chars (should be 100):', valueAfterFill.length);

const pass = maxlengthAttr === '100' &&
  valueAfterFill.length === 100 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2343: upload wizard product name input enforces a 100-character maxlength matching the server cap',
  errors,
});
