// #2764 (sub-issue of #2763, owner-requested): persistent Group/Ungroup for
// placed items. Confirms the real Build-mode UI flow end to end: forming a
// group via the toolbar, that selecting any one member afterward (even
// after a reload, so this is exercising the persisted groupId round-tripped
// through createMeshForInstance -- not just in-memory state from the same
// session that formed it) selects/moves the whole group together, and that
// Ungroup fully dissolves it back to independent single-item selection.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Group Ungroup Tester';

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

// Two trees, far enough apart on screen that a plain tap lands cleanly on
// just one of them.
await placeTreeAt(160, 380);
await placeTreeAt(260, 380);

// Placing the second tree auto-selected it (selectOnly, per
// handlePlacementClick) — clear that on open ground before building the
// real multi-select below, same reasoning e2e/build-mode-brush-select.test.mjs's
// own setup comment gives.
await page.mouse.click(60, 550);
await page.waitForTimeout(300);

// Real projected screen positions (not the original click coordinates — a
// tall model's footprint projects above its flat ground-click point once
// perspective applies, per #1945/__testProductScreenPositions' own
// comment), used for every click below so this doesn't depend on guessing
// where either tree actually rendered.
const positions = await page.evaluate(() => window.__testProductScreenPositions());
console.log('two trees placed, real projected screen positions:', JSON.stringify(positions));
const [posA, posB] = positions;
const instanceAId = posA.instanceId;
const instanceBId = posB.instanceId;

// Build a real multi-select of both via the toolbar toggle (not the brush —
// a plain tap in multi-select mode already calls toggleInSelection per the
// canvas click handler), then form a group.
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);

const multiSelectInfo = await page.textContent('#product-info');
console.log('status after multi-selecting both trees (should be "2 items selected"):', multiSelectInfo);

// Leaving multi-select on is fine for Group/Ungroup (see updateSelectionUI's
// own #2764 comment — they stay enabled during multi-select), so this
// doesn't need to toggle it off first.
const groupEnabledBeforeGrouping = await page.locator('#group-item').isEnabled();
const ungroupDisabledBeforeGrouping = await page.locator('#ungroup-item').isDisabled();
console.log('Group enabled / Ungroup disabled with 2 ungrouped items selected (both should be true):', groupEnabledBeforeGrouping, ungroupDisabledBeforeGrouping);

await page.click('#group-item');
await page.waitForTimeout(500);

const ungroupEnabledAfterGrouping = await page.locator('#ungroup-item').isEnabled();
console.log('Ungroup enabled immediately after grouping (should be true):', ungroupEnabledAfterGrouping);

const afterGroupFetch = await page.evaluate(async ([a, b]) => {
  const [resA, resB] = await Promise.all([fetch(`/api/instances/${a}`), fetch(`/api/instances/${b}`)]);
  const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
  return { groupIdA: bodyA.instance?.groupId, groupIdB: bodyB.instance?.groupId };
}, [instanceAId, instanceBId]);
console.log('both instances\' persisted groupId right after grouping (should be equal, non-null):', afterGroupFetch);

// Clear the selection, then reload entirely — this is the real test of
// whether grouping actually persisted server-side and round-trips back
// through createMeshForInstance's own groupId carry-through, not just
// in-memory state left over from the session that formed the group.
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

// Tapping just A (ordinary single-select, multi-select is off after a
// reload) should pull in B too — selecting any one member of a persisted
// group selects/moves the whole group.
await page.mouse.click(reloadedA.x, reloadedA.y);
await page.waitForTimeout(300);
const selectionAfterTappingOneMember = await page.textContent('#product-info');
console.log('status after tapping only A post-reload (should still be "2 items selected" -- the group expanded the selection):', selectionAfterTappingOneMember);

const ungroupEnabledAfterReload = await page.locator('#ungroup-item').isEnabled();
console.log('Ungroup enabled after the group-expanded tap (should be true):', ungroupEnabledAfterReload);

await page.click('#ungroup-item');
await page.waitForTimeout(500);

const afterUngroupFetch = await page.evaluate(async ([a, b]) => {
  const [resA, resB] = await Promise.all([fetch(`/api/instances/${a}`), fetch(`/api/instances/${b}`)]);
  const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
  return { groupIdA: bodyA.instance?.groupId, groupIdB: bodyB.instance?.groupId };
}, [instanceAId, instanceBId]);
console.log('both instances\' persisted groupId after ungrouping (should both be null):', afterUngroupFetch);

// Clear, then tap A alone one more time — now that the group is dissolved,
// this should select only A (template name text, not a 2-items count).
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
await page.mouse.click(reloadedA.x, reloadedA.y);
await page.waitForTimeout(300);
const selectionAfterUngroupTap = await page.textContent('#product-info');
console.log('status after tapping A alone post-ungroup (should NOT say "2 items selected" anymore):', selectionAfterUngroupTap);

const pass =
  multiSelectInfo.includes('2 items selected') &&
  groupEnabledBeforeGrouping &&
  ungroupDisabledBeforeGrouping &&
  ungroupEnabledAfterGrouping &&
  !!afterGroupFetch.groupIdA &&
  afterGroupFetch.groupIdA === afterGroupFetch.groupIdB &&
  !!reloadedA &&
  selectionAfterTappingOneMember.includes('2 items selected') &&
  ungroupEnabledAfterReload &&
  afterUngroupFetch.groupIdA === null &&
  afterUngroupFetch.groupIdB === null &&
  !selectionAfterUngroupTap.includes('2 items selected') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2764: Group/Ungroup persist across reload, and selecting one grouped member expands to the whole group',
  errors,
});
