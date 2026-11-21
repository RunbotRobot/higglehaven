// #4019: Settings > Build kept everything open and covered 86% of a phone screen. Its first screen is now
// Publish and the newest version; the username/lándlet cap/low stock/sold-out markers are one closed row
// ("Profile, lándlet cap and stock"), Higgles and auctions another, and the versions before the newest sit
// in a closed "Earlier versions" row. A row starts closed each time Settings opens and stays as left while
// it is open.
//
// e2e/helpers.mjs's budAware() installs a locator handler that opens any closed `.settings-account-fold` whenever
// a Playwright action or a locator wait runs while its summary is on screen, so a measurement taken after one
// of those would only ever see open rows. Everything below that asserts a row is closed therefore reads the page
// through page.evaluate/page.waitForFunction and clicks with the DOM's own click(), which the handler never sees.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, openBuildMoreFold, openEarlierVersions } from './helpers.mjs';

const LABEL = 'Build Folds Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 844 });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Settings opens on the Build tab in Build mode, so there is no tab to click (a click would let the handler
// open the new, closed rows before they could be looked at).
async function openBuildTab() {
  await openAccountMenu(page);
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.querySelector('#settings-modal.visible') && document.querySelector('.settings-more-fold'), null, { timeout: 10000 });
}

const isOpen = (selector) => page.evaluate((s) => document.querySelector(s)?.hasAttribute('open') ?? null, selector);
// On screen the way a person sees it: a closed <details> hides everything in it but its summary (the
// content still reports a box in Chromium, so offsetWidth cannot tell).
const visibleCount = (selector) => page.evaluate((s) => [...document.querySelectorAll(s)]
  .filter((el) => !(el.closest('details:not([open])') && !el.closest('summary'))
    && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)).length, selector);
const domClick = (selector) => page.evaluate((s) => document.querySelector(s).click(), selector);

await openBuildTab();
// Publish sits on the first screen, not in a row.
await page.waitForFunction(() => [...document.querySelectorAll('.version-action-btn')].some((b) => b.textContent.trim() === 'Publish'), null, { timeout: 10000 });
const publishInFold = await page.evaluate(() => [...document.querySelectorAll('.version-action-btn')]
  .find((b) => b.textContent.trim() === 'Publish')?.closest('details') != null);
const moreClosedAtStart = (await isOpen('.settings-more-fold')) === false;
const higglesClosedAtStart = (await isOpen('.settings-higgles-fold')) === false;
// The lándlet cap field is drawn (it loads) but hidden inside the closed row.
await page.waitForFunction(() => document.getElementById('land-cap-field'), null, { timeout: 10000 });
const capHiddenAtStart = (await visibleCount('#land-cap-field')) === 0;
const capInsideMore = await page.evaluate(() => !!document.querySelector('.settings-more-fold #land-cap-field'));
const usernameInsideMore = await page.evaluate(() => [...document.querySelectorAll('.settings-more-fold .settings-field span')].some((s) => s.textContent.trim() === 'Username'));
const summaries = await page.evaluate(() => [...document.querySelectorAll('#settings-section > details > summary')].map((s) => s.textContent.trim()));
console.log('closed rows (should be Higgles and auctions, then Profile, lándlet cap and stock):', summaries);
console.log('Publish is not inside a fold (should be false):', publishInFold);
console.log('Profile row closed at start (should be true):', moreClosedAtStart, '; Higgles row closed (should be true):', higglesClosedAtStart);
console.log('lándlet cap hidden at start (should be true):', capHiddenAtStart, '; inside the Profile row (should be true):', capInsideMore, '; username inside it (should be true):', usernameInsideMore);

// With nothing published there is no earlier version, so no "Earlier versions" row is shown.
await page.waitForFunction(() => document.querySelector('.version-list')?.textContent.includes('No versions saved yet'), null, { timeout: 15000 });
const earlierHiddenWithNoVersions = await page.evaluate(() => document.querySelector('.settings-earlier-versions')?.hidden === true);

// Opening the Profile row shows the cap.
await openBuildMoreFold(page);
const capVisibleWhenOpen = (await visibleCount('#land-cap-field')) === 1;
console.log('lándlet cap visible once the row is open (should be true):', capVisibleWhenOpen);

// It stays open while Settings stays open (a tab switch redraws the tab).
await domClick('.settings-tab-btn[data-section="general"]');
await page.waitForFunction(() => !document.querySelector('.settings-more-fold'), null, { timeout: 10000 });
await domClick('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(() => document.querySelector('.settings-more-fold'), null, { timeout: 10000 });
const stillOpenAfterRedraw = (await isOpen('.settings-more-fold')) === true;
console.log('Profile row still open after the tab was redrawn (should be true):', stillOpenAfterRedraw);

// Two published versions: only the newest is on the first screen; the earlier one is in the closed row.
await page.click('.version-action-btn:has-text("Publish")');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, null, { timeout: 20000 });
await page.click('.version-action-btn:has-text("Publish")');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 2, null, { timeout: 20000 });
await page.waitForFunction(() => document.querySelector('.settings-earlier-versions:not([hidden])'), null, { timeout: 10000 });
const visibleRowsClosed = await visibleCount('.version-row');
const newestFirst = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.version-row')];
  return rows.length === 2 && !rows[0].closest('.settings-earlier-versions') && !!rows[1].closest('.settings-earlier-versions');
});
console.log('version rows on screen with the earlier row closed (should be 1):', visibleRowsClosed);
console.log('newest version outside the Earlier versions row, the other inside it (should be true):', newestFirst);
await openEarlierVersions(page);
const visibleRowsOpen = await visibleCount('.version-row');
console.log('version rows on screen with Earlier versions open (should be 2):', visibleRowsOpen);

// Settings opened again starts with the Profile row closed.
await domClick('#settings-close-btn');
await page.waitForFunction(() => !document.querySelector('#settings-modal.visible'), null, { timeout: 10000 });
await openBuildTab();
const closedAgainOnReopen = (await isOpen('.settings-more-fold')) === false;
console.log('Profile row closed again after Settings was closed and reopened (should be true):', closedAgainOnReopen);

const pass = publishInFold === false &&
  moreClosedAtStart && higglesClosedAtStart &&
  capHiddenAtStart && capInsideMore && usernameInsideMore &&
  summaries.includes('Higgles and auctions') && summaries.includes('Profile, lándlet cap and stock') &&
  earlierHiddenWithNoVersions &&
  capVisibleWhenOpen && stillOpenAfterRedraw &&
  visibleRowsClosed === 1 && newestFirst && visibleRowsOpen === 2 &&
  closedAgainOnReopen &&
  errors.length === 0;
await finish(browser, { pass, label: 'Settings > Build: rarely used groups and earlier versions are folded (#4019)', errors });
