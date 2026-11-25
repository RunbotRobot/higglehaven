// #4162 (leaf 4 of #4158): nudge and turn the selected item from the keyboard in Build. Shift with the
// arrows slides it a step in its own axes, Shift with Page Up and Page Down lifts and lowers it, Shift
// with Q and E turns it; without Shift those keys still move the camera; a focused field keeps its keys.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Build Item Keys Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(160, 380);
await page.waitForTimeout(1200);

const item = () => page.evaluate(() => {
  const p = window.__testProductPositions()[0];
  return { x: p.x, y: p.y, z: p.z, yaw: window.__testSelectedItemState?.()?.yaw ?? null };
});
const cam = () => page.evaluate(() => window.__testBuildCameraPose());
const press = async (combo, times = 1) => { for (let i = 0; i < times; i += 1) { await page.keyboard.press(combo); await page.waitForTimeout(220); } };
const moved = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// Shift+Right slides it sideways by a step; Shift+Left slides it back.
let before = await item();
await press('Shift+ArrowRight', 3);
let after = await item();
check(moved(before, after) > 0.15 && moved(before, after) < 0.45, `Shift+Right slides the item a few steps (${moved(before, after).toFixed(2)} m)`);
before = after;
await press('Shift+ArrowLeft', 3);
after = await item();
check(moved(before, after) > 0.15, 'Shift+Left slides it back');

// A press that worked says what it did for a screen reader (the hidden live region).
const said = () => page.evaluate(() => document.getElementById('build-select-status').textContent.replace(/\u200b/g, ''));
await press('Shift+ArrowLeft');
check(/^Moved .* to the left\.$/.test(await said()), `a nudge is announced (${JSON.stringify(await said())})`);
await press('Shift+KeyQ');
check(/^Turned 5 degrees left\.$/.test(await said()), `a turn is announced (${JSON.stringify(await said())})`);

// Forward and back move it along the ground the other way.
const startFwd = await item();
await press('Shift+ArrowUp', 2);
const afterFwd = await item();
check(moved(startFwd, afterFwd) > 0.1, 'Shift+Up slides it forward');
await press('Shift+ArrowDown', 2);

// Page Up lifts, Page Down lowers (it can rest on the floor).
before = await item();
await press('Shift+PageUp', 3);
after = await item();
check(after.z > before.z + 0.15, `Shift+Page Up lifts it (${before.z.toFixed(2)} -> ${after.z.toFixed(2)})`);
await press('Shift+PageDown', 3);
after = await item();
check(Math.abs(after.z - before.z) < 0.05, 'Shift+Page Down lowers it back');

// Q and E turn the item (and nothing else moves).
const yawOf = () => page.evaluate(() => {
  const state = window.__testSelectedItemState?.();
  return state ? JSON.stringify(state) : null;
});
const stateBefore = await yawOf();
await press('Shift+KeyE', 4);
const stateAfter = await yawOf();
check(stateBefore !== null && stateAfter !== stateBefore, `Shift+E turns the item (${stateBefore} -> ${stateAfter})`);

// Without Shift the same keys move the camera and leave the item alone.
const itemBefore = await item();
const camBefore = await cam();
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(600);
await page.keyboard.up('ArrowRight');
const camAfter = await cam();
const itemAfter = await item();
check(moved(camBefore.target, camAfter.target) > 0.5, 'plain Right still slides the view');
check(moved(itemBefore, itemAfter) < 0.01, 'and leaves the item where it is');

// A focused field keeps its keys.
await page.evaluate(() => {
  const input = document.createElement('input');
  input.id = 'kb-item-field';
  document.body.appendChild(input);
  input.focus();
});
const fieldBefore = await item();
await page.keyboard.press('Shift+ArrowRight');
await page.waitForTimeout(300);
check(moved(fieldBefore, await item()) < 0.01, 'keys typed in a field do not move the item');
await page.evaluate(() => document.getElementById('kb-item-field').remove());

await finish(browser, { pass: pass && errors.length === 0, label: '#4162: Shift with the arrows, Page Up/Down and Q/E moves and turns the selected item', errors });
