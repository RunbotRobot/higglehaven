// #3359 (cluster 5): a failed bundle rename or share-toggle in the catalog
// picker used to alert(), which a browser that suppresses native dialogs drops
// without a trace. It now shows the in-app notice modal: persistent, with the
// server's reason, and the picker stays open behind it. Native dialogs are
// counted so the test fails if one ever fires again.
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs } from './helpers.mjs';

const LABEL = 'Bundle Failure Notice Tester';
const BUNDLE = 'Failure Notice Bundle';
const REASON = 'Bundles are read-only right now.';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(150, 400);
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), null, { timeout: 60000 });
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
await saveBundleAs(page, BUNDLE, { shared: true });
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.waitForSelector('.bundle-tile', { timeout: 10000 });

// From here every native dialog is counted and dismissed (what a suppressing
// browser does), and every bundle update is refused by the server.
let nativeDialogs = 0;
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => { nativeDialogs += 1; await dialog.dismiss(); });
await page.route('**/api/bundles/*', async (route) => {
  if (route.request().method() === 'PATCH') {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: REASON }) });
  } else {
    await route.continue();
  }
});

async function expectNoticeAfter(clickAction, label) {
  await clickAction();
  await page.waitForSelector('#notice-modal.visible', { timeout: 5000 });
  const message = await page.textContent('#notice-modal-message');
  const title = await page.textContent('#notice-modal-title');
  console.log(`${label}: notice title/message:`, title, '|', message);
  await page.click('#notice-modal-ok-btn');
  await page.waitForFunction(() => !document.getElementById('notice-modal').classList.contains('visible'), null, { timeout: 5000 });
  const pickerStillOpen = await page.locator('#catalog-picker.visible').count();
  return { showsReason: message.includes(REASON), pickerStillOpen: pickerStillOpen === 1 };
}

const share = await expectNoticeAfter(() => page.locator('.bundle-tile-share').first().click(), 'share toggle');
const shareBtnUsable = await page.locator('.bundle-tile-share').first().isEnabled();

// Rename: open the name modal, type a new name, submit.
const rename = await expectNoticeAfter(async () => {
  await page.locator('.bundle-tile-rename').first().click();
  await page.waitForSelector('#bundle-name-modal.visible', { timeout: 5000 });
  await page.fill('#bundle-name-input', `${BUNDLE} 2`);
  await page.click('#bundle-name-save-btn');
}, 'rename');
const renameBtnUsable = await page.locator('.bundle-tile-rename').first().isEnabled();

console.log('native dialogs fired (should be 0):', nativeDialogs);
const pass = share.showsReason && share.pickerStillOpen && shareBtnUsable
  && rename.showsReason && rename.pickerStillOpen && renameBtnUsable
  && nativeDialogs === 0
  && errors.every((e) => /500|Internal Server Error|Failed to load resource/.test(e));
await finish(browser, {
  pass,
  label: '#3359: a failed bundle rename or share-toggle shows an in-app notice, not a native alert',
  errors: errors.filter((e) => !/500|Internal Server Error|Failed to load resource/.test(e)),
});
