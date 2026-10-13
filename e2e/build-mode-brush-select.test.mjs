// #1945: Build mode's multi-select brush lets a drag sweep up every placed
// item within an adjustable screen-space radius of the cursor, rather than
// requiring the drag to pass exactly over each one (the "mass-selecting
// bricks in a wall is difficult" ask). Proven here by placing one item off
// to the side of two others and confirming a brush radius short of its real
// on-screen offset from the straight line between them misses it, while one
// past that offset catches it.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Brush Select Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}

async function setBrushSize(px) {
  await page.evaluate((value) => {
    const el = document.getElementById('multiselect-brush-size-input');
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, px);
}

// A and B roughly in line, C deliberately offset to one side of it. A tall
// model's own placed position (its footprint's center, not the flat ground
// point clicked — see handlePlacementClick) projects to a different screen
// pixel than the click itself, so the actual brush-drag coordinates below
// come from each tree's own real projected screen position (read back via
// a test-only hook), not from these click coordinates.
await placeTreeAt(160, 400);
await placeTreeAt(260, 400);
await placeTreeAt(210, 460);

// Placing the third tree auto-selected it — clear that on open ground away
// from all three before starting, the same reasoning bundles.test.mjs's
// own setup comment gives.
await page.mouse.click(60, 550);
await page.waitForTimeout(300);

const positions = await page.evaluate(() => window.__testProductScreenPositions());
console.log('three trees placed, real projected screen positions:', JSON.stringify(positions));
const [posA, posB, posC] = positions;

// Perpendicular distance from C to the straight line A-B — the brush
// radius below is chosen to straddle this real, measured value rather than
// a guess.
function perpendicularDistance(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const abLenSq = abx * abx + aby * aby;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const closestX = a.x + abx * t, closestY = a.y + aby * t;
  return Math.hypot(p.x - closestX, p.y - closestY);
}
const cOffsetFromLine = perpendicularDistance(posC, posA, posB);
console.log("C's real perpendicular distance from the A-B line in screen px (the small/large brush below straddle this):", cOffsetFromLine);

await page.click('#toggle-multiselect');
await page.waitForTimeout(300);

const brushControlVisibleOnceMultiSelectOn = await page.locator('#multiselect-brush-control').isVisible();
console.log('brush size control appears once multi-select turns on (should be true):', brushControlVisibleOnceMultiSelectOn);

// Small brush, just enough to cover A/B's own exact points but well short
// of reaching C: a straight drag along the real A-B line should pick up
// only A and B.
const smallRadius = Math.max(10, Math.round(cOffsetFromLine / 2));
await setBrushSize(smallRadius);
await page.mouse.move(posA.x, posA.y);
await page.mouse.down();
await page.mouse.move(posB.x, posB.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const smallBrushSelection = await page.textContent('#product-info');
console.log(`selection after a ${smallRadius}px-radius brush drag along the real A-B line (should be "2 items selected", short of C's ${cOffsetFromLine.toFixed(0)}px offset):`, smallBrushSelection);

// Back to single-select, clear the selection, then re-enter multi-select
// with an empty selection for the next drag.
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);

// Large brush, past C's real offset from the line: the same drag should
// now sweep it in too.
const largeRadius = Math.min(150, Math.ceil(cOffsetFromLine) + 20);
await setBrushSize(largeRadius);
await page.mouse.move(posA.x, posA.y);
await page.mouse.down();
await page.mouse.move(posB.x, posB.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const largeBrushSelection = await page.textContent('#product-info');
console.log(`selection after a ${largeRadius}px-radius brush drag along the same line (should be "3 items selected", now past C's offset):`, largeBrushSelection);

const pass = brushControlVisibleOnceMultiSelectOn &&
  largeRadius > cOffsetFromLine && // sanity: the large radius actually did clear C's real offset
  smallBrushSelection.includes('2 items selected') &&
  largeBrushSelection.includes('3 items selected') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1945: Build mode multi-select brush size controls how far a drag sweeps up nearby placed items',
  errors,
});
