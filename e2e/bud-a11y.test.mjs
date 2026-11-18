// #3818 (part of #3539): the flower for someone who cannot see it or cannot use touch. At 390x844,
// in Shop, Build and Sell: the head, its menu and a leaf have names a screen reader reads (the "?" is
// Help, the compass is not read), the head's name carries its word and unread mark, opening the menu
// from the keyboard puts focus in it and Escape gives it back, a leaf is modal and keeps Tab inside
// it, nothing in the menu is under 12px or under 44px to tap, and reduced motion fades instead of
// growing or pulsing.
import { launchPage, chooseIdentity, goToMode, claimLandlet, finish } from './helpers.mjs';
import { setupBudWordHelpers } from './bud-a11y-helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'A11y Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: 'A11y Tester', isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const { smallText, tapTargetsUnder44, headName } = setupBudWordHelpers(page);

async function openMenuFromKeyboard() {
  await page.waitForTimeout(1500); // the opening screen has lifted and the head's click handlers are wired
  await page.focus('#account-menu-toggle');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('account-menu-panel').classList.contains('expanded'), null, { timeout: 5000 });
  await page.waitForTimeout(700);
}

for (const mode of ['shop', 'build', 'sell']) {
  if (mode !== 'shop') await goToMode(page, mode, { openProducts: false });
  if (mode === 'build') { await claimLandlet(page); await page.waitForTimeout(800); }
  await page.waitForSelector(`body[data-mode="${mode}"][data-bud="on"]`, { timeout: 30000 });

  // The head: linked to its menu, closed.
  check((await page.getAttribute('#account-menu-toggle', 'aria-controls')) === 'account-menu-panel', `${mode}: the head names the menu it opens (aria-controls)`);
  check((await page.getAttribute('#account-menu-toggle', 'aria-expanded')) === 'false', `${mode}: the head says the menu is closed`);

  // Opened with the keyboard: focus goes into the menu.
  await openMenuFromKeyboard();
  check(await page.evaluate(() => !!document.activeElement.closest('#account-menu-panel')), `${mode}: opening the menu from the keyboard puts focus in it`);
  check((await page.getAttribute('#account-menu-toggle', 'aria-expanded')) === 'true', `${mode}: the head says the menu is open`);

  // The tree: the help leaf is Help, the modes are a group with the current one marked, no compass.
  const menuTree = await page.locator('#account-menu-panel').ariaSnapshot();
  const ringTree = await page.locator('#bud-modes').ariaSnapshot();
  check(/button "Help"/.test(menuTree), `${mode}: the "?" leaf is named Help (got ${JSON.stringify(menuTree)})`);
  check(!/\bN E S W\b|compass/i.test(menuTree), `${mode}: the compass is not read out`);
  check(new RegExp(`button "${mode[0].toUpperCase()}${mode.slice(1)}" \\[pressed\\]`).test(ringTree), `${mode}: the current mode's petal is announced as current (got ${JSON.stringify(ringTree)})`);
  check(/group "Places"/.test(ringTree), `${mode}: the three modes are a named group`);

  // Sizes: no text under 12px; every control to tap is at least 44px in both directions.
  const small = await smallText();
  check(small.length === 0, `${mode}: no text under 12px in the menu (${JSON.stringify(small)})`);
  const tiny = await tapTargetsUnder44();
  check(tiny.length === 0, `${mode}: every control in the menu is at least 44px (${JSON.stringify(tiny)})`);

  // Escape closes the menu and gives focus back to the head.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check((await page.getAttribute('#account-menu-toggle', 'aria-expanded')) === 'false', `${mode}: Escape closes the menu`);
  check((await page.evaluate(() => document.activeElement.id)) === 'account-menu-toggle', `${mode}: Escape returns focus to the head`);
}

// A leaf (Help, from Shop): modal, focus inside from the start, Tab never leaves it, Escape closes it
// and returns to the head.
await goToMode(page, 'shop');
await page.waitForSelector('body[data-mode="shop"][data-bud="on"]', { timeout: 30000 });
await page.click('#account-menu-toggle');
await page.waitForTimeout(600);
await page.click('#bud-petal-shop-help');
await page.waitForSelector('#bud-leaf-help', { timeout: 5000 });
await page.waitForTimeout(500);
check((await page.getAttribute('#bud-leaf-help', 'aria-modal')) === 'true', 'a leaf is modal');
check(!!(await page.getAttribute('#bud-leaf-help', 'aria-labelledby')), 'a leaf is named by its title');
check(await page.evaluate(() => !!document.activeElement.closest('#bud-leaf-help')), 'focus starts inside the leaf');
const close = await page.evaluate(() => { const r = document.querySelector('#bud-leaf-help .bud-leaf-close').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
check(close[0] >= 44 && close[1] >= 44, `the leaf's close control is at least 44px (${close})`);
let escaped = 0;
for (let i = 0; i < 30; i++) {
  await page.keyboard.press('Tab');
  if (!(await page.evaluate(() => !!document.activeElement.closest('#bud-leaf-help')))) escaped += 1;
}
check(escaped === 0, `Tab stays inside an open leaf (left it ${escaped} of 30 times)`);
let escapedBack = 0;
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Shift+Tab');
  if (!(await page.evaluate(() => !!document.activeElement.closest('#bud-leaf-help')))) escapedBack += 1;
}
check(escapedBack === 0, `Shift+Tab stays inside an open leaf (left it ${escapedBack} of 12 times)`);
const smallInLeaf = await smallText();
check(smallInLeaf.length === 0, `no text under 12px in the leaf (${JSON.stringify(smallInLeaf)})`);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check(await page.evaluate(() => !document.getElementById('bud-leaf-help')), 'Escape closes the leaf');
check((await page.evaluate(() => document.activeElement.id)) === 'account-menu-toggle', 'Escape on a leaf returns focus to the head');

// The head's plain name.
check((await headName()) === 'Account menu', `the head's plain name (${await headName()})`);

// Reduced motion: the petals and leaves fade; nothing grows or pulses.
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.click('#account-menu-toggle');
await page.waitForTimeout(150);
const motion = await page.evaluate(() => document.getAnimations()
  .map((a) => a.animationName || '')
  .filter((n) => n && n !== 'bud-fade'));
check(motion.length === 0, `under reduced motion only fades run (got ${JSON.stringify(motion)})`);

await finish(browser, { pass, label: 'bud-a11y.test.mjs', errors });
