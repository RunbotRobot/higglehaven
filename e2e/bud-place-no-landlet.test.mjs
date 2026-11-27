// #3887 (job 7, claim a lándlet): a person with no lándlet yet opens Build and is shown the Claim a lándlet sheet. The
// menu used to name the lándlet Shop last stood on (the starter lot) as "by <me>", putting their name on a lot that
// belongs to someone else. With no lándlet of their own the menu names nothing. 390x844.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'No Lot Yet';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForTimeout(2500);
await openAccountMenu(page);
await page.waitForTimeout(1500);
const place = await page.evaluate(() => {
  const el = document.getElementById('account-menu-landlet-info');
  return { hidden: !el || el.hidden, text: el ? el.textContent.trim() : '' };
});
console.log('place sign for a person with no lándlet (should be hidden):', JSON.stringify(place));
check(place.hidden, 'the menu names no lándlet for a person who has none');
check(!place.text.includes(LABEL) || place.hidden, 'and never "by" the person who owns nothing');
await finish(browser, { pass: pass && errors.length === 0, label: '#3887: the menu does not name a lándlet the person does not own', errors });
