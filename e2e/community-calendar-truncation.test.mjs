// #1274: same truncation-notice gap as e2e/community-sign-truncation.test.mjs,
// for handleCalendarEvents' twin windowed-list-plus-real-totalCount shape.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Calendar Event Truncation Tester';
const FAKE_TOTAL_COUNT = 304;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Place a tree and select it (placement auto-selects, per handlePlacementClick).
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const communityCalendarBtn = () => page.locator('#toggle-community-calendar');
await communityCalendarBtn().click();
await page.waitForTimeout(500);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const calendarInstance = instances.find((i) => i.templateId === 'placeholder-tree');

await page.route(`**/api/instances/${calendarInstance.instanceId}/events*`, async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      events: [
        { eventId: 'fake-event-1', authorLabel: LABEL, text: 'First', createdAt: new Date().toISOString(), scheduledAt: null },
        { eventId: 'fake-event-2', authorLabel: LABEL, text: 'Second', createdAt: new Date().toISOString(), scheduledAt: null },
      ],
      totalCount: FAKE_TOTAL_COUNT,
    }),
  });
});

// A second click on the same (still-selected, now-flagged) button opens
// Manage Events instead of un-flagging.
await communityCalendarBtn().click();
await page.waitForSelector('#calendar-events-modal.visible', { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('.calendar-event-row').length === 2, { timeout: 5000 });

const rowCount = await page.locator('.calendar-event-row').count();
const truncatedHidden = await page.locator('#calendar-events-truncated').evaluate((el) => el.hidden);
const truncatedText = await page.locator('#calendar-events-truncated').textContent();
console.log('rows shown in the panel (should be 2, the mocked window):', rowCount);
console.log('truncation notice hidden (should be false):', truncatedHidden);
console.log(`truncation notice text (should mention the real totalCount ${FAKE_TOTAL_COUNT}, not the mocked array length 2):`, truncatedText);

const pass =
  rowCount === 2 &&
  truncatedHidden === false &&
  truncatedText.includes(String(FAKE_TOTAL_COUNT)) &&
  truncatedText.includes('2') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Calendar events panel shows a truncation notice built from the real totalCount, not the windowed array length (#1274)', errors });
