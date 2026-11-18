// #1324: four icon-only buttons (no visible text) had no accessible name
// at all -- #account-menu-toggle just rendered a raw Unicode character. Confirms
// it has a real aria-label a screen reader can announce. (#3769: the fly up/down
// arrows are gone; height follows the view.)
import { launchPage, finish, chooseIdentity } from './helpers.mjs';

const LABEL = 'Icon Button A11y Suite';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Shop mode (the default landing mode) gates entry behind a real account
// (N44) -- needed before the account menu toggle renders.
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });

const accountMenuToggleLabel = await page.getAttribute('#account-menu-toggle', 'aria-label');
console.log('#account-menu-toggle aria-label (should be set):', accountMenuToggleLabel);


const pass = Boolean(accountMenuToggleLabel) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Icon-only buttons (account menu) have a real accessible name (#1324)',
  errors,
});
