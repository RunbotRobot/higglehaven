// Measure mode vs. Add-Item/Paste placement (issue #422). Measure is its
// own sibling tap-driven tool (see exitMeasureMode's own comment in
// src/main.js) — nothing used to stop it and a pending placement from
// being active at once, and the canvas click handler always checked
// Measure first, silently swallowing every placement tap into a ruler
// point instead. Covers both directions: turning Measure off when a
// placement flow starts (enterPlacementMode's own exitMeasureMode call),
// and canceling a pending placement when Measure is toggled on instead
// (measureBtn's own click handler).
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Measure Mode Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const measureActive = () => page.locator('#toggle-measure').evaluate((el) => el.classList.contains('active'));
const addItemBtnText = () => page.textContent('#add-item-btn');

// Direction 1: Measure on, then start a placement flow — Measure should
// turn itself off rather than go on swallowing every subsequent tap.
await page.click('#toggle-measure');
const measureActiveBeforePlacement = await measureActive();
console.log('Measure active right after toggling it on (should be true):', measureActiveBeforePlacement);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
const measureActiveDuringPlacement = await measureActive();
console.log('Measure active once a placement is pending (should be false — entering placement exits it):', measureActiveDuringPlacement);

await page.mouse.click(210, 400);
await page.waitForTimeout(800);
const productInfoAfterPlace = await page.textContent('#product-info');
console.log('product-info after tapping to place with Measure previously on (should be non-empty, not still "Tap a spot..."):', productInfoAfterPlace);
const addItemBtnTextAfterPlace = await addItemBtnText();
console.log('Add Item button text right after a successful placement (should be back to "+ Add Item"):', addItemBtnTextAfterPlace);

// Direction 2: a placement already pending, then Measure is toggled on —
// the pending placement should be canceled rather than left stranded
// un-cancelable behind Measure's own tap handling.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
const addItemBtnTextWhilePending = await addItemBtnText();
console.log('Add Item button text with a placement pending (should be "✕ Cancel"):', addItemBtnTextWhilePending);

await page.click('#toggle-measure');
await page.waitForTimeout(300);
const measureActiveAfterCancelToggle = await measureActive();
console.log('Measure active after toggling it on with a placement pending (should be true):', measureActiveAfterCancelToggle);
const addItemBtnTextAfterCancelToggle = await addItemBtnText();
console.log('Add Item button text after Measure canceled the pending placement (should be back to "+ Add Item"):', addItemBtnTextAfterCancelToggle);

// Leave Measure off for a clean exit.
await page.click('#toggle-measure');
await page.waitForTimeout(300);

const pass =
  measureActiveBeforePlacement &&
  !measureActiveDuringPlacement &&
  !productInfoAfterPlace.toLowerCase().includes('tap a spot') &&
  addItemBtnTextAfterPlace.trim() === '+ Add Item' &&
  addItemBtnTextWhilePending.trim() === '✕ Cancel' &&
  measureActiveAfterCancelToggle &&
  addItemBtnTextAfterCancelToggle.trim() === '+ Add Item' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Measure mode does not swallow Add-Item placement taps in either direction', errors });
