// #3876: a leaf folds back into the flower instead of vanishing. At 390x844 in Shop: open the Help leaf and close it
// with its close control. At once the real leaf is gone (its id is free, nothing can find it), a picture of it is
// still on screen folding (an inert copy with no ids), and it is removed on its own a moment later. A leaf opened
// during the fold takes the same id with no clash, and the one open leaf is the only one with that id.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Leaf Fold';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });

async function openHelp() {
  await openAccountMenu(page);
  await page.locator('#bud-row button:visible', { hasText: /^Help$/ }).first().click();
  await page.waitForSelector('#bud-leaf-help', { timeout: 5000 });
}

await openHelp();
// Close from the page itself, in one step, so what is read next is the instant after the close.
const atClose = await page.evaluate(() => {
  document.querySelector('#bud-leaf-help .bud-leaf-close').click();
  const ghost = document.querySelector('.bud-leaf-folding');
  return {
    realLeafGone: document.getElementById('bud-leaf-help') === null,
    ghostThere: Boolean(ghost),
    ghostInert: ghost?.hasAttribute('inert') === true && ghost?.getAttribute('aria-hidden') === 'true',
    ghostIdsLeft: ghost ? ghost.querySelectorAll('[id]').length + (ghost.id ? 1 : 0) : -1,
    ghostCloseFindable: document.querySelectorAll('.bud-leaf-close').length, // only a real leaf's close control carries the class
    ghostCanBeTapped: ghost ? getComputedStyle(ghost).pointerEvents !== 'none' : null,
  };
});
console.log('at the instant of closing:', JSON.stringify(atClose));

// A leaf opened during the fold takes the id with no clash.
await openHelp();
const duringFold = await page.evaluate(() => document.querySelectorAll('#bud-leaf-help').length);
console.log('leaves with the id while a fold may still be playing (should be 1):', duringFold);

await page.waitForFunction(() => document.querySelector('.bud-leaf-folding') === null, null, { timeout: 5000 });
const afterwards = await page.evaluate(() => document.querySelectorAll('.bud-leaf').length);
console.log('leaves on screen once the fold is done (should be 1, the open one):', afterwards);

const pass = atClose.realLeafGone && atClose.ghostThere && atClose.ghostInert && atClose.ghostIdsLeft === 0
  && atClose.ghostCloseFindable === 0 && atClose.ghostCanBeTapped === false && duringFold === 1 && afterwards === 1;
await finish(browser, { pass, label: '#3876: a closing leaf folds back (an inert copy) and is removed, never a clash on its id', errors });
