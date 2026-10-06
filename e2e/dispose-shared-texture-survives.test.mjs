// Regression test for #1359: disposeObject now also disposes each
// material's own textures (.map etc), not just the geometry/material --
// but loadModelInstance's own comment explains every instance of the
// *same* model URL shares one cached geometry, and Material.clone() only
// shallow-copies a material (texture references, not the textures
// themselves), so two placed instances of the same model share their
// underlying THREE.Texture objects too. Disposing one instance's textures
// must not break the other still-placed instance's rendering -- confirms
// it doesn't (no page errors, the surviving instance stays selectable)
// after deleting its sibling.
import { launchPage, chooseIdentity, claimLandlet, clickUntilSelected, finish } from './helpers.mjs';

const LABEL = 'Shared Texture Dispose Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Place two Trees -- same catalog model URL, so they share the cached
// geometry and (per loadModelInstance's own comment) the same underlying
// textures across their independently-cloned materials.
async function placeTree(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), { timeout: 10000 });
}

await placeTree(150, 400);
const firstTreeInfo = await page.textContent('#product-info');
console.log('product-info right after placing the first Tree (should mention Tree):', firstTreeInfo);

await placeTree(270, 400);
const secondTreeInfo = await page.textContent('#product-info');
console.log('product-info right after placing the second Tree (should mention Tree):', secondTreeInfo);

// Delete the second (currently selected) Tree -- this disposes its
// geometry/material/textures, all shared with the first Tree.
await page.click('#delete-item');
await page.waitForTimeout(500);

// Click the first Tree to confirm it's still there, still selectable, and
// still renders without the page throwing (a disposed-but-still-referenced
// Texture/BufferGeometry should just get lazily re-uploaded by the
// renderer on next use, not break -- the same sharing the existing code
// already relied on for geometry disposal). A small vertical scan, not a
// single fixed click -- deselecting narrows a placed item's own clickable
// footprint (loses its selection-gizmo halo), same reasoning
// clickUntilSelected's own doc comment gives.
const afterDeleteInfo = await clickUntilSelected(page, { x: 150, yStart: 380, yEnd: 440, expectedText: 'Tree' });
console.log('product-info after clicking the surviving Tree (should still mention Tree):', afterDeleteInfo);

const pass = firstTreeInfo.includes('Tree') &&
  secondTreeInfo.includes('Tree') &&
  afterDeleteInfo.includes('Tree') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: "#1359: disposing one instance's shared textures doesn't break a sibling instance of the same model",
  errors,
});
