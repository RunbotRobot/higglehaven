// #4685 (found walking #4677): a price typed with a fraction of a cent used to be rounded silently when the person
// tapped Create, because the blur reformat of the field ran before the submit check of #4368 could see it. The field now
// keeps what was typed, and the step says "Prices go to the cent, like 12.99.".
import { launchPage, chooseIdentity, claimLandlet, finish, openAddProductLeaf } from './helpers.mjs';

const LABEL = 'Cent Fraction Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

await page.fill('#upload-name', 'Cent Product');
await page.fill('#upload-price', '12.999');
await page.click('#upload-submit-btn');
await page.waitForTimeout(300);
const status = (await page.locator('#upload-status').textContent()).trim();
const value = await page.inputValue('#upload-price');
console.log('status after tapping Create with 12.999 (should refuse the fraction of a cent):', status);
console.log('the field still holds what was typed (should be 12.999):', value);

await page.fill('#upload-price', '12.5');
await page.locator('#upload-name').focus();
const tidied = await page.inputValue('#upload-price');
console.log('a whole-cent price is still tidied on leaving the field (should be $12.50):', tidied);

const pass = status.startsWith('Prices go to the cent') && value === '12.999' && tidied === '$12.50' && errors.length === 0;
await finish(browser, { pass, label: '#4685: a fraction of a cent is refused where it is typed, never rounded on a tap', errors });
