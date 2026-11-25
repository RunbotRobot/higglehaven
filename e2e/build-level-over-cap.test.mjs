// #4331: a builder at their lándlet cap is not offered a level that can only be refused. Build above and Dig below
// are drawn as unavailable with the reason beside them (the same figures the My lándlets leaf uses), and no request
// is sent for a level the cap cannot take. 390x844.
import { launchPage, chooseIdentity, claimLandlet, openBudMenuOf, finish } from './helpers.mjs';

const LABEL = 'Level Over Cap Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let levelRequests = 0;
await page.route('**/api/landlets/*/levels', (route) => {
  if (route.request().method() === 'POST') levelRequests += 1;
  return route.continue();
});

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await openBudMenuOf(page, 'build');
await page.click('#bud-petal-build-levels');
await page.waitForSelector('#level-build-btn', { state: 'visible', timeout: 5000 });
// The cap is read when the leaf draws; give it a moment.
await page.waitForFunction(() => document.getElementById('level-build-btn').disabled, null, { timeout: 8000 }).catch(() => {});

const state = await page.evaluate(() => ({
  buildDisabled: document.getElementById('level-build-btn').disabled,
  digDisabled: document.getElementById('level-dig-btn').disabled,
  note: document.getElementById('level-status').textContent,
  noteIsError: document.getElementById('level-status').classList.contains('error'),
}));
console.log('both level buttons unavailable at the cap (should be true, true):', state.buildDisabled, state.digDisabled);
console.log('the reason beside them:', state.note);

// A tap on an unavailable button sends nothing.
await page.evaluate(() => { document.getElementById('level-build-btn').click(); document.getElementById('level-dig-btn').click(); });
await page.waitForTimeout(800);
console.log('level requests sent (should be 0):', levelRequests);

const pass = state.buildDisabled && state.digDisabled
  && /A new level takes 1,000m² and you have 0m² left/.test(state.note)
  && /The cap grows as your products earn higgles/.test(state.note)
  && !/\.\d\dm²/.test(state.note)
  && levelRequests === 0;
await finish(browser, { pass: pass && errors.length === 0, label: '#4331: at the cap the level buttons are unavailable with the reason, and nothing is sent', errors });
