// #3574 (part of #3539, Build mode audit): Paste, Redo, Unbundle and Edit are
// left out until they can be used, instead of sitting greyed in the toolbar.
import { launchPage, chooseIdentity, claimLandlet, finish, budClick, budShows } from './helpers.mjs';

const LABEL = 'Hidden Controls Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const shown = async (id) => page.locator(id).isVisible();
// #3690: Redo is half of the Undo/Redo petal of the bud, so it is looked for with the bud open.
const before = { paste: await shown('#paste-btn'), redo: await budShows(page, '#redo-btn') };

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
await budClick(page, '#undo-btn');
await page.waitForTimeout(800);
const redoAfterUndo = await budShows(page, '#redo-btn');
console.log('before:', JSON.stringify(before), 'one tree selected:', JSON.stringify(selected), 'paste after copy:', pasteAfterCopy, 'redo after undo:', redoAfterUndo);

const pass = !before.paste && !before.redo && !selected.unbundle && !selected.edit && pasteAfterCopy && redoAfterUndo && errors.length === 0;
await finish(browser, { pass, label: '#3574: Paste, Redo, Unbundle and Edit appear only when usable', errors });
