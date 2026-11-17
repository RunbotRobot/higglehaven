// #3574 (part of #3539, Build mode audit): Paste, Redo, Unbundle and Edit are
// left out until they can be used, instead of sitting greyed in the toolbar. Redo is a petal of
// the bud (#3690), so it is looked for with the bud open.
import { launchPage, chooseIdentity, claimLandlet, finish, openAccountMenu } from './helpers.mjs';

const LABEL = 'Hidden Controls Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const shown = async (id) => page.locator(id).isVisible();
const shownInBud = async (id) => {
  await openAccountMenu(page);
  const visible = await shown(id);
  await page.keyboard.press('Escape');
  return visible;
};
const before = { paste: await shown('#paste-btn'), redo: await shownInBud('#redo-btn') };

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(200, 380);
await page.waitForTimeout(800);

const selected = { unbundle: await shown('#ungroup-item'), edit: await shown('#edit-bundle-item') };
await page.click('#copy-item');
await page.waitForTimeout(300);
const pasteAfterCopy = await shown('#paste-btn');
await page.click('#undo-btn');
await page.waitForTimeout(800);
const redoAfterUndo = await shownInBud('#redo-btn');
console.log('before:', JSON.stringify(before), 'one tree selected:', JSON.stringify(selected), 'paste after copy:', pasteAfterCopy, 'redo after undo:', redoAfterUndo);

const pass = !before.paste && !before.redo && !selected.unbundle && !selected.edit && pasteAfterCopy && redoAfterUndo && errors.length === 0;
await finish(browser, { pass, label: '#3574: Paste, Redo, Unbundle and Edit appear only when usable', errors });
