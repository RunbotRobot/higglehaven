// #3219: Build mode's "cam / tgt / dir" camera-pose readout is a developer
// aid. An ordinary builder must not see it; an admin account still does.
import { launchPage, chooseIdentity, grantAdmin, emailForLabel, finish } from './helpers.mjs';

const LABEL = 'Camera Readout Builder';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
// The readout refreshes on a 200 ms throttle inside the render loop.
await page.waitForTimeout(1500);
const shownToOrdinary = await page.locator('#camera-debug-panel').isVisible();
console.log('camera readout visible to an ordinary builder (should be false):', shownToOrdinary);

await grantAdmin(emailForLabel(LABEL));
await page.reload();
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#undo-redo-panel', { state: 'attached', timeout: 15000 });
await page.waitForSelector('#camera-debug-panel.admin-visible', { timeout: 10000 }).catch(() => {});
const shownToAdmin = await page.locator('#camera-debug-panel').isVisible();
const text = await page.textContent('#camera-debug');
console.log('camera readout visible to an admin (should be true):', shownToAdmin, JSON.stringify(text));

await finish(browser, {
  pass: !shownToOrdinary && shownToAdmin && /cam\s/.test(text || '') && errors.length === 0,
  label: '#3219: the Build-mode camera readout is shown to admins only',
  errors,
});
