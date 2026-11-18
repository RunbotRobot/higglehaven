// #1324: four icon-only buttons (no visible text) had no accessible name
// at all -- #shop-up-btn/#shop-down-btn/
// #account-menu-toggle just rendered a raw Unicode character. Confirms
// each now has a real aria-label a screen reader can announce.
import { launchPage, finish, chooseIdentity } from './helpers.mjs';

const LABEL = 'Icon Button A11y Suite';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Shop mode (the default landing mode) gates entry behind a real account
// (N44) -- needed before #shop-up-btn/#shop-down-btn render.
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });

const accountMenuToggleLabel = await page.getAttribute('#account-menu-toggle', 'aria-label');
console.log('#account-menu-toggle aria-label (should be set):', accountMenuToggleLabel);


const upBtnLabel = await page.getAttribute('#shop-up-btn', 'aria-label');
console.log('#shop-up-btn aria-label (should be set):', upBtnLabel);

const downBtnLabel = await page.getAttribute('#shop-down-btn', 'aria-label');
console.log('#shop-down-btn aria-label (should be set):', downBtnLabel);

const pass = Boolean(accountMenuToggleLabel) &&
  Boolean(upBtnLabel) &&
  Boolean(downBtnLabel) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Icon-only buttons (fly up/down, account menu) have a real accessible name (#1324)',
  errors,
});
