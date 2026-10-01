// Vertical construction — Build-mode UI (issue #169, sub-issue of #167's
// tracking issue). The data model/API (#168) and the cap-cost math itself
// are covered by worker/land.test.js's own "Landlet levels" tests; this
// covers only the real frontend flow this issue adds: digging down/
// building up a level through #level-controls, navigating between
// already-built levels, the cap-cost preview shown before committing, and
// that a level (and an item placed on it) survives a reload.
import { launchPage, chooseIdentity, claimLandlet, grantLandCapHeadroomAsAdmin, openLevelMenu, finish } from './helpers.mjs';

const LABEL = 'Vertical Levels Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

// #489: land cap now gates adding a level, and a freshly-claimed builder's
// owned area already equals their default cap exactly — this suite is
// about the level-controls UI, not the cap gate itself, so grant real
// headroom first (see grantLandCapHeadroomAsAdmin's own comment).
const builderId = await page.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));
await grantLandCapHeadroomAsAdmin(builderId);

const levelLabel = () => page.textContent('#level-label');
const removeHidden = () => page.isHidden('#level-remove-btn');

// #1153: the nav/build/dig/remove controls this whole suite drives are now
// tucked behind #level-menu-toggle — opened once here, and it stays open
// (doesn't auto-close on an inner click, see openLevelMenu's own comment)
// for every interaction below until the reload partway through resets it.
await openLevelMenu(page);

const initialLabel = await levelLabel();
const removeHiddenAtGround = await removeHidden();
const buildBtnAtGround = await page.textContent('#level-build-btn');
console.log('initial level label (should be Ground):', initialLabel);
console.log('Remove button hidden at ground (should be true):', removeHiddenAtGround);
console.log('Build button shows a cost preview at ground (should mention "m²"):', buildBtnAtGround);

// #831: delay only the very next level-creation request so there's a
// reliable window to observe the concurrent-click guard's disabled state
// below while it's still in flight — reading it immediately after click()
// otherwise races an in-memory-D1 response that can resolve faster than a
// loaded CI runner's own automation round-trip, making this flaky under
// load despite the guard itself working correctly (mirrors the same
// delay-the-request idiom upload-cancel-race.test.mjs already uses). Scoped
// to a one-shot flag rather than page.unroute()-ing it afterward — unrouting
// while the delayed handler's own route.continue() is still pending races
// Playwright's own route resolution and throws "Route is already handled!".
let delayedOnce = false;
await page.route('**/api/landlets/*/levels', async (route) => {
  if (!delayedOnce) {
    delayedOnce = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await route.continue();
});

// Build a level up.
await page.click('#level-build-btn');
// Concurrent-click guard (issue #403): Dig/Remove (not just Build itself)
// must also be disabled while the Build request is still in flight —
// otherwise a second click before this one resolves could race on
// currentLevelIndex/currentLandletLevels, each independently overwriting
// the other's result depending on which server round-trip finishes last.
const digDisabledMidFlight = await page.isDisabled('#level-dig-btn');
console.log('Dig button disabled while Build request is in flight (should be true):', digDisabledMidFlight);
// #1077: Up/Down were never part of the same busy gate as Build/Dig/Remove
// — clickable mid-flight, they let a manual navigation get silently
// discarded the moment the in-flight action's own completion handler
// overwrote currentLevelIndex back to whatever it just built/dug/removed.
const upDisabledMidFlight = await page.isDisabled('#level-up-btn');
const downDisabledMidFlight = await page.isDisabled('#level-down-btn');
console.log('Up button disabled while Build request is in flight (should be true):', upDisabledMidFlight);
console.log('Down button disabled while Build request is in flight (should be true):', downDisabledMidFlight);
await page.waitForTimeout(800);
const digEnabledAfterBuild = !(await page.isDisabled('#level-dig-btn'));
console.log('Dig button re-enabled after Build settles (should be true):', digEnabledAfterBuild);
const labelAfterBuild = await levelLabel();
const removeVisibleAfterBuild = !(await removeHidden());
console.log('level label after building up (should be Level +1):', labelAfterBuild);
console.log('Remove button visible after building (should be true):', removeVisibleAfterBuild);

// Navigate down to ground and back up — pure client-side view, no network
// write — then place an item while looking at Level +1.
await page.click('#level-down-btn');
await page.waitForTimeout(300);
const labelAfterNavDown = await levelLabel();
await page.click('#level-up-btn');
await page.waitForTimeout(300);
const labelAfterNavUp = await levelLabel();
console.log('level label after nav down (should be Ground):', labelAfterNavDown);
console.log('level label after nav back up (should be Level +1):', labelAfterNavUp);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);
const productInfoAfterPlace = await page.textContent('#product-info');
console.log('product-info after placing on Level +1 (should be non-empty, not still "Tap a spot..."):', productInfoAfterPlace);

// Reload — a fresh session, same builder — and confirm the level itself
// (not just the placed item) persisted server-side.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForTimeout(1500);
await openLevelMenu(page);

const labelAfterReload = await levelLabel();
console.log('level label right after reload (should be Ground — always starts there):', labelAfterReload);
await page.click('#level-up-btn');
await page.waitForTimeout(300);
const labelAfterReloadNavUp = await levelLabel();
const removeVisibleAfterReload = !(await removeHidden());
console.log('level label after nav up post-reload (should be Level +1 — level persisted):', labelAfterReloadNavUp);
console.log('Remove button visible post-reload (should be true):', removeVisibleAfterReload);

// #1077: place a fresh item first so there's real undo history to gate —
// the reload above wiped the in-page undoStack, and an empty stack already
// disables #undo-btn on its own, which would make the mid-flight check
// below meaningless (disabled either way, gate engaged or not).
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
// Offset from (210, 400), where the pre-reload placement above landed (and
// persisted through the reload, re-rendering at the same screen position) —
// close enough to still land on the buildable ground plane in view, far
// enough to clear that item's own TransformControls gizmo.
await page.mouse.click(150, 600);
await page.waitForTimeout(800);
const undoEnabledBeforeRemove = !(await page.isDisabled('#undo-btn'));
console.log('Undo enabled before removing the level (should be true — real history to undo):', undoEnabledBeforeRemove);
// Deselect (tap empty space, well clear of both placed items) before
// removing the level: placement auto-selects the new item, and removing a
// level with a selected/gizmo-attached item still on it orphans the gizmo
// (filed separately as #1078 — a different bug in the same handler, out of
// #1077's own scope). Undo history is already captured above; this suite
// only needs #1077's busy-gate behavior, not #1078's.
await page.mouse.click(30, 700);
await page.waitForTimeout(300);

// Remove the level (it's outermost, so this should succeed), then dig one
// down from ground instead.
let removeDelayedOnce = false;
await page.route('**/api/landlets/*/levels/*', async (route) => {
  if (!removeDelayedOnce) {
    removeDelayedOnce = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await route.continue();
});
// The add-item/placement/deselect taps above all landed outside the level
// menu's own toggle/panel, closing it per its own outside-click handler —
// reopen before driving it again.
await openLevelMenu(page);
await page.click('#level-remove-btn');
// #1077: levelRemoveBtn's own handler mutates productMeshes (pruning #901's
// swept instances) after this request resolves, but never claimed the
// shared beginSceneMutation()/endSceneMutation() gate Undo/Redo/Place/Paste
// all go through — an Undo racing this in-flight request could splice
// productMeshes concurrently with the pruning loop, the exact orphaned-mesh
// shape #402 fixed everywhere else. #undo-btn's own disabled state directly
// reflects sceneMutationBusy (updateUndoRedoButtons), so it doubles as a
// direct observation of whether the gate is actually held.
const undoDisabledMidFlight = await page.isDisabled('#undo-btn');
console.log('Undo disabled while Remove request is in flight (should be true — the gate is held):', undoDisabledMidFlight);
await page.waitForTimeout(800);
const labelAfterRemove = await levelLabel();
const removeHiddenAfterRemove = await removeHidden();
console.log('level label after removing Level +1 (should be Ground):', labelAfterRemove);
console.log('Remove button hidden again after removing (should be true):', removeHiddenAfterRemove);

await page.click('#level-dig-btn');
await page.waitForTimeout(800);
const labelAfterDig = await levelLabel();
console.log('level label after digging down (should be Level -1):', labelAfterDig);

const pass =
  initialLabel === 'Ground' &&
  removeHiddenAtGround &&
  buildBtnAtGround.includes('m²') &&
  labelAfterBuild === 'Level +1' &&
  digDisabledMidFlight &&
  upDisabledMidFlight &&
  downDisabledMidFlight &&
  digEnabledAfterBuild &&
  removeVisibleAfterBuild &&
  labelAfterNavDown === 'Ground' &&
  labelAfterNavUp === 'Level +1' &&
  !productInfoAfterPlace.toLowerCase().includes('tap a spot') &&
  labelAfterReload === 'Ground' &&
  labelAfterReloadNavUp === 'Level +1' &&
  removeVisibleAfterReload &&
  undoEnabledBeforeRemove &&
  undoDisabledMidFlight &&
  labelAfterRemove === 'Ground' &&
  removeHiddenAfterRemove &&
  labelAfterDig === 'Level -1' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Vertical construction: Build-mode level controls', errors });
