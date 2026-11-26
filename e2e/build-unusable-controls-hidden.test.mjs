// #3574 (part of #3539, Build mode audit): Paste, Redo, Unbundle and Edit are
// left out until they can be used, instead of sitting greyed in the toolbar. Bundle (needs two items)
// and Trim (needs a trimmable item) follow the same rule.
import { launchPage, chooseIdentity, claimLandlet, finish, budClick, budShows } from './helpers.mjs';

const LABEL = 'Hidden Controls Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const shown = async (id) => page.locator(id).isVisible();
// #3691: Paste is lent to the Tools leaf, so it is not drawn until that is open; what this test
// is about is whether it is offered, which is its `hidden` and `disabled`.
const pasteOffered = () => page.locator('#paste-btn').evaluate((el) => !el.hidden && !el.disabled);
// #4411: Undo and Redo are the owner's exception: always drawn in their own row, greyed when idle. Redo is "offered"
// when it is enabled.
const redoOffered = () => page.locator('#redo-btn').evaluate((el) => !el.hidden && !el.disabled);
const before = { paste: await pasteOffered(), redo: await redoOffered() };

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(200, 380);
await page.waitForTimeout(800);

const selected = { unbundle: await shown('#ungroup-item'), edit: await shown('#edit-bundle-item'), bundle: await shown('#group-item') };
// A Tree is not trimmable, so Trim is left out too (and with Move and Rotate gone, so is the whole tool row, #3689).
const trimShown = await shown('#mode-trim');
const toolRowShown = await shown('#gizmo-mode-controls');
await page.click('#copy-item');
await page.waitForTimeout(300);
const pasteAfterCopy = await pasteOffered();
await budClick(page, '#undo-btn');
await page.waitForTimeout(800);
const redoAfterUndo = await redoOffered();
console.log('before:', JSON.stringify(before), 'one tree selected:', JSON.stringify(selected), 'paste after copy:', pasteAfterCopy, 'redo after undo:', redoAfterUndo);

const pass = !before.paste && !before.redo && !selected.unbundle && !selected.edit && !selected.bundle && !trimShown && !toolRowShown && pasteAfterCopy && redoAfterUndo && errors.length === 0;
await finish(browser, { pass, label: '#3574: Paste, Bundle, Trim, Unbundle and Edit appear only when usable, and Redo is greyed until something was undone', errors });
