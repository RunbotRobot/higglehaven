// #3530 (owner, 2026-11-15): Settings > Shop > Controls told people to
// "double-tap" an emoji dove, but the HUD's fly button shows a robin on a
// branch (an image), so the instruction named something that is not on
// screen. The Controls line now draws the fly button's own picture, from the
// same asset through shopFlyBtnIconSrc (src/shop/flightMovement.js), so the
// two cannot drift apart. Phone width.
import {
  launchPage, chooseIdentity, openAccountMenu, finish,
} from './helpers.mjs';

const LABEL = 'Controls Bird Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'shop', label: LABEL });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });

const hudSrc = await page.getAttribute('#shop-fly-btn-icon', 'src');

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
await page.waitForSelector('.settings-fly-icon', { timeout: 5000 });
const noteText = await page.evaluate(() => document.querySelector('.settings-fly-icon').parentElement.textContent);
const iconSrc = await page.getAttribute('.settings-fly-icon', 'src');
const iconLoaded = await page.evaluate(() => {
  const img = document.querySelector('.settings-fly-icon');
  return img.complete && img.naturalWidth > 0;
});
const box = await page.locator('.settings-fly-icon').boundingBox();
console.log('fly button icon on the HUD:', hudSrc);
console.log('picture in the Controls line (should be the same file):', iconSrc);
console.log('Controls text (should have no emoji dove):', noteText);
console.log('picture loaded (should be true):', iconLoaded, 'size', box && Math.round(box.width), 'x', box && Math.round(box.height));

await finish(browser, {
  label: '#3530: Settings Controls shows the fly button\'s own bird',
  pass: hudSrc === iconSrc && !noteText.includes('🕊') && iconLoaded && !!box && box.width > 12 && box.width < 40,
  errors,
});
