// #2765 (sub-issue of #2763, depends on #2764): Save Bundle groups the
// selected items in place, not just the bundle *definition* for later reuse
// — per the owner's direct request on #2763. Confirms the real Build-mode
// UI flow: Save Bundle on a 2-item multi-select persists a shared groupId
// (same groupInstancesRemote mechanism #2764's own Group button uses), and
// that this round-trips through a reload the same way an explicit Group
// action does (e2e/group-ungroup.test.mjs's own #2764 test covers that
// persistence shape for the Group button itself; this test is the Save
// Bundle trigger path specifically, not a retest of #2764's own mechanism).
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs } from './helpers.mjs';

const LABEL = 'Bundle Save Grouping Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

await placeTreeAt(160, 380);
await placeTreeAt(260, 380);

// Placing the second tree auto-selected it — clear that on open ground
// before building the real multi-select below, same reasoning
// e2e/group-ungroup.test.mjs's own setup comment gives.
await page.mouse.click(60, 550);
await page.waitForTimeout(300);

const positions = await page.evaluate(() => window.__testProductScreenPositions());
console.log('two trees placed, real projected screen positions:', JSON.stringify(positions));
const [posA, posB] = positions;
const instanceAId = posA.instanceId;
const instanceBId = posB.instanceId;

await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);

const multiSelectInfo = await page.textContent('#product-info');
console.log('status after multi-selecting both trees (should be "2 items selected"):', multiSelectInfo);

// #2761: Save Bundle now opens a themed name-prompt modal instead of
// resolving immediately (replacing the native prompt()/confirm() this test
// originally wrote against) -- saveBundleAs covers the click plus filling
// and confirming that modal, same helper e2e/bundles.test.mjs's own Save
// Bundle flow uses.
await saveBundleAs(page, LABEL);
// #2639 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeout itself is widened to 60000ms for real headroom under
// CI load, same as e2e/bundles.test.mjs's own Save Bundle wait.
await page.waitForFunction(
  () => document.getElementById('product-info').textContent.includes('Saved'),
  null,
  { timeout: 60000 },
);
const savedStatus = await page.textContent('#product-info');
console.log('status right after Save Bundle (should mention Saved, 2 items, and NOT mention a grouping failure):', savedStatus);

// The actual #2765 assertion: the two instances' persisted groupId, set by
// Save Bundle's own grouping call -- not just the bundle definition.
const afterSaveFetch = await page.evaluate(async ([a, b]) => {
  const [resA, resB] = await Promise.all([fetch(`/api/instances/${a}`), fetch(`/api/instances/${b}`)]);
  const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
  return { groupIdA: bodyA.instance?.groupId, groupIdB: bodyB.instance?.groupId };
}, [instanceAId, instanceBId]);
console.log('both instances\' persisted groupId right after Save Bundle (should be equal, non-null):', afterSaveFetch);

// Save Bundle's own toolbar refresh is deliberately deferred
// (setTimeout(updateSelectionUI, 1200), same delay the "Saved ..." message
// itself rides on) rather than synchronous like Group/Ungroup's own click
// handlers -- wait past that window before reading the button's enabled
// state, or this would just be racing that existing debounce.
await page.waitForTimeout(1500);
const ungroupEnabledAfterSave = await page.locator('#ungroup-item').isEnabled();
console.log('Ungroup enabled after Save Bundle\'s deferred toolbar refresh (should be true -- current selection is now a real group):', ungroupEnabledAfterSave);

// Clear the selection, then reload entirely — confirms Save Bundle's
// grouping call actually persisted server-side and round-trips back through
// createMeshForInstance's own groupId carry-through, not just in-memory
// state left over from the click that formed it.
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForTimeout(1500);

const positionsAfterReload = await page.evaluate(() => window.__testProductScreenPositions());
console.log('real screen positions after reload:', JSON.stringify(positionsAfterReload));
const reloadedA = positionsAfterReload.find((p) => p.instanceId === instanceAId);

// Tapping just A (ordinary single-select) should pull in B too — selecting
// any one member of a persisted group selects/moves the whole group, same
// as an explicitly-Grouped selection would.
await page.mouse.click(reloadedA.x, reloadedA.y);
await page.waitForTimeout(300);
const selectionAfterTappingOneMember = await page.textContent('#product-info');
console.log('status after tapping only A post-reload (should still be "2 items selected" -- Save Bundle\'s grouping expanded the selection):', selectionAfterTappingOneMember);

const pass =
  multiSelectInfo.includes('2 items selected') &&
  savedStatus.includes('Saved') && savedStatus.includes('2 item') &&
  !savedStatus.includes('could not group') &&
  !!afterSaveFetch.groupIdA &&
  afterSaveFetch.groupIdA === afterSaveFetch.groupIdB &&
  ungroupEnabledAfterSave &&
  !!reloadedA &&
  selectionAfterTappingOneMember.includes('2 items selected') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2765: Save Bundle groups the selected items in place, surviving a reload',
  errors,
});
