// #3328 (leaf 5/7 of #3323): Edit opens a selected bundle so its members can
// be picked one at a time.
//   - unsaved bundle: Edit enters at once, no prompt; tapping a member
//     selects just it; Done returns to the unit;
//   - saved (linked) bundle, creator: Edit asks first in the in-app modal;
//     Never mind leaves the unit selected; Confirm enters; Escape leaves;
//     a second Edit this session does not ask again;
//   - saved bundle placed by another builder: Edit disabled, with the reason
//     visible, and Unbundle still enabled.
// Phone width (launchPage's default 420px viewport).
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs, acceptConfirmModal } from './helpers.mjs';

const OWNER = 'Bundle Edit Owner';
const OTHER = 'Bundle Edit Other';

const ownerSession = await launchPage({ promptAnswer: OWNER });
const otherSession = await launchPage({ promptAnswer: OTHER });
const page = ownerSession.page;

await chooseIdentity(page, { mode: 'build', label: OWNER, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function placeTreeAt(p, x, y) {
  await p.click('#add-item-btn');
  await p.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await p.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await p.waitForTimeout(300);
  await p.mouse.click(x, y);
  await p.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), null, { timeout: 60000 });
}

await placeTreeAt(page, 160, 380);
await placeTreeAt(page, 260, 380);
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
const positions = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
for (const pos of positions) {
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(200);
}
await page.click('#group-item');
await page.waitForTimeout(700);
await page.click('#mode-move'); // leaves multi-select, keeps the bundle selected
await page.waitForTimeout(300);

const editBtn = page.locator('#edit-bundle-item');
const modalVisible = () => page.locator('#confirm-modal.visible').count();
const info = () => page.textContent('#product-info');

// --- Unsaved bundle: no prompt. ---
const unsavedEnabled = await editBtn.isEnabled();
await editBtn.click();
await page.waitForTimeout(300);
const unsavedModal = await modalVisible();
const unsavedLabel = await editBtn.textContent();
console.log('unsaved: Edit enabled, no modal, button reads Done:', unsavedEnabled, unsavedModal, unsavedLabel);

const afterEdit = await page.evaluate(() => window.__testProductScreenPositions());
await page.mouse.click(afterEdit[0].x, afterEdit[0].y);
await page.waitForTimeout(300);
const memberInfo = await info();
console.log('tapping a member in edit mode selects just it (should not say "items selected"):', memberInfo);

await editBtn.click(); // Done
await page.waitForTimeout(300);
const unitInfo = await info();
const unsavedBack = await editBtn.textContent();
console.log('Done returns to the unit (should say "2 items selected"):', unitInfo, '| button:', unsavedBack);

// --- Save it (shared) so it becomes a linked template. ---
await saveBundleAs(page, OWNER, { shared: true });
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
const afterSave = await page.evaluate(() => window.__testProductScreenPositions());
await page.mouse.click(afterSave[0].x, afterSave[0].y);
await page.waitForTimeout(400);
await page.waitForFunction(() => !document.getElementById('edit-bundle-item').disabled, null, { timeout: 15000 });

// --- Linked, creator: confirm first. ---
await editBtn.click();
await page.waitForSelector('#confirm-modal.visible', { timeout: 10000 });
const modalMessage = await page.textContent('#confirm-modal-message');
await page.click('#confirm-modal-cancel-btn');
await page.waitForTimeout(300);
const afterNever = await info();
const labelAfterNever = await editBtn.textContent();
console.log('Never mind: unit still selected, button still Edit:', afterNever, labelAfterNever);

await editBtn.click();
await acceptConfirmModal(page);
await page.waitForTimeout(300);
const labelAfterConfirm = await editBtn.textContent();
console.log('Confirm enters edit (should read Done):', labelAfterConfirm);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const labelAfterEscape = await editBtn.textContent();
const unitAfterEscape = await info();
console.log('Escape leaves edit:', labelAfterEscape, unitAfterEscape);

await editBtn.click(); // acknowledged this session: no second prompt
await page.waitForTimeout(300);
const secondModal = await modalVisible();
const labelSecond = await editBtn.textContent();
console.log('second Edit asks again (should be 0) / reads Done:', secondModal, labelSecond);
await editBtn.click();
await page.waitForTimeout(200);

// --- Another builder places the shared bundle: Edit disabled. ---
const other = otherSession.page;
await chooseIdentity(other, { mode: 'build', label: OTHER, isNew: true });
await claimLandlet(other);
await other.click('#add-item-btn');
await other.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await other.click('.bundle-tab-btn[data-bundle-tab="community"]');
await other.waitForTimeout(500);
await other.locator('.bundle-tile').filter({ hasText: OWNER }).locator('.bundle-tile-place').click();
await other.waitForTimeout(300);
await other.mouse.click(210, 500);
await other.waitForFunction(() => document.getElementById('product-info').textContent.includes('items selected'), null, { timeout: 60000 });
await other.waitForFunction(() => document.getElementById('edit-bundle-reason').textContent.includes('Only the builder'), null, { timeout: 15000 });
const otherEditDisabled = await other.locator('#edit-bundle-item').isDisabled();
const reason = await other.textContent('#edit-bundle-reason');
const unbundleEnabled = await other.locator('#ungroup-item').isEnabled();
console.log('other builder: Edit disabled / reason / Unbundle enabled:', otherEditDisabled, reason, unbundleEnabled);

const errors = [...ownerSession.errors, ...otherSession.errors];
const pass = unsavedEnabled && unsavedModal === 0 && unsavedLabel === 'Done' &&
  !memberInfo.includes('items selected') && memberInfo.includes('Tree') &&
  unitInfo.includes('2 items selected') && unsavedBack === 'Edit' &&
  modalMessage.includes("other builders' lándlets") &&
  afterNever.includes('2 items selected') && labelAfterNever === 'Edit' &&
  labelAfterConfirm === 'Done' && labelAfterEscape === 'Edit' && unitAfterEscape.includes('2 items selected') &&
  secondModal === 0 && labelSecond === 'Done' &&
  otherEditDisabled && reason.includes('Only the builder who saved this bundle can change it') && unbundleEnabled &&
  errors.length === 0;
await otherSession.browser.close();
await finish(ownerSession.browser, { pass, label: 'bundle edit mode: confirm for a linked bundle, creator-only', errors });
