// Community calendar (docs/SPEC.md §6: "Community calendar reuses the
// identical pattern [as community signs], builder-authored") — structurally
// a twin of community signs (e2e/community-signs.test.mjs): a builder flags
// a placed instance via the "Community Calendar" toggle, and shoppers can
// then leave short event postings on it (rendered in-world as fading
// floating text in Shop mode, via the same updateCalendarFade/
// makeSignPostSprite machinery signs use — not covered here for the same
// reason: real camera movement and native browser dialogs are exercised
// manually instead, documented in docs/API.md). This test covers the
// pieces that ARE reliably automatable: the build-mode toggle-then-manage
// button, the Manage Events moderation panel (#calendar-events-modal,
// including its own "Remove Community Calendar" button), and the backend
// calendar-events API all three unlock.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Community Calendar Suite Tester';

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
const labelBefore = await communityCalendarBtn().textContent();
console.log('Community Calendar button label before toggling (should be plain "Community Calendar"):', labelBefore);

await communityCalendarBtn().click();
await page.waitForTimeout(500);
const labelAfterOn = await communityCalendarBtn().textContent();
console.log('Community Calendar button label after toggling on (should mention Manage):', labelAfterOn);

// Read back the persisted flag directly from the API.
const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const calendarInstance = instances.find((i) => i.templateId === 'placeholder-tree');
console.log('isCommunityCalendar persisted after toggling on (should be true):', calendarInstance.isCommunityCalendar);

// Leave a couple of events via the same API the in-world "Add an Event"
// button calls (createCalendarEvent in src/api.js), then list them back.
await fetchJson(`/api/instances/${calendarInstance.instanceId}/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'A Builder', text: 'Bonfire night, Friday 8pm!' }),
});
await fetchJson(`/api/instances/${calendarInstance.instanceId}/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'Another Builder', text: 'Market day, Saturday morning.' }),
});
const { events } = (await fetchJson(`/api/instances/${calendarInstance.instanceId}/events`)).body;
console.log('events on the calendar (should be 2, oldest first):', events.map((e) => `${e.authorLabel}: ${e.text}`));

// A second click on the same (still-selected) button now opens Manage
// Events instead of un-flagging.
await communityCalendarBtn().click();
await page.waitForSelector('#calendar-events-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const rowCountInPanel = await page.locator('.calendar-event-row').count();
const firstRowText = await page.locator('.calendar-event-row').first().textContent();
console.log('rows shown in the panel (should be 2):', rowCountInPanel);
console.log('first row mentions author+text (should mention "A Builder" and "Bonfire night"):', firstRowText);

// Delete the second event via its row's own × button (not the API
// directly) — this is the actual moderation path a builder would use.
await page.locator('.calendar-event-row').filter({ hasText: 'Another Builder' }).locator('.calendar-event-row-delete').click();
await page.waitForFunction(() => document.querySelectorAll('.calendar-event-row').length === 1, { timeout: 5000 });
const rowCountAfterDelete = await page.locator('.calendar-event-row').count();
console.log('rows shown after deleting one via the panel (should be 1):', rowCountAfterDelete);

const { events: eventsAfterDelete } = (await fetchJson(`/api/instances/${calendarInstance.instanceId}/events`)).body;
console.log('events persisted server-side after the panel delete (should be 1, the surviving one authored by "A Builder"):', eventsAfterDelete.map((e) => e.authorLabel));

// Scheduled events + the one-shot creative-tool trigger (docs/SPEC.md
// §6's own "scheduled confetti-cannon" example) — posted directly via the
// API (the in-world "Add an Event" flow's own third, optional prompt for
// this isn't reachable here for the same reason the rest of Shop mode's
// prompt-driven flow isn't — see this file's own header comment), but the
// Manage Events panel's *display* of a scheduled event, and the trigger
// endpoint's own no-op-before-due behavior, are both real UI/API surfaces
// this test can and does cover. The full due->fires->shows-"Fired at"
// path needs scheduled_at forced into the past, which (unlike
// worker/index.test.js) this suite has no direct D1 access to do — that
// half is covered by worker/index.test.js's own dedicated case instead.
await page.click('#calendar-events-close-btn');
await page.waitForTimeout(300);
const scheduledPost = await fetchJson(`/api/instances/${calendarInstance.instanceId}/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'A Builder', text: 'Fireworks!', scheduledAt: '2099-01-01T00:00:00.000Z' }),
});
const scheduledEventId = scheduledPost.body.event.eventId;

await communityCalendarBtn().click();
await page.waitForSelector('#calendar-events-modal.visible', { timeout: 5000 });
await page.waitForTimeout(300);
const scheduledRowText = await page.locator('.calendar-event-row').filter({ hasText: 'Fireworks!' }).textContent();
console.log('scheduled (not yet due) event row (should show "Scheduled for"):', scheduledRowText);

// Not yet due — triggering now should be a no-op.
const notDueTrigger = await fetchJson(`/api/instances/${calendarInstance.instanceId}/events/${scheduledEventId}/trigger`, { method: 'POST' });
console.log('trigger attempt before it is due (should be triggered: false):', notDueTrigger.body.triggered);

// "Remove Community Calendar," inside the panel, un-flags and closes it.
await page.click('#calendar-events-unflag-btn');
await page.waitForTimeout(500);
const modalHiddenAfterUnflag = await page.locator('#calendar-events-modal').evaluate((el) => !el.classList.contains('visible'));
const labelAfterOff = await communityCalendarBtn().textContent();
const { instances: instancesAfterOff } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const calendarInstanceAfterOff = instancesAfterOff.find((i) => i.instanceId === calendarInstance.instanceId);
console.log('calendar-events-modal closed after unflagging (should be true):', modalHiddenAfterUnflag);
console.log('Community Calendar button label after unflagging (should be plain again):', labelAfterOff);
console.log('isCommunityCalendar persisted after unflagging (should be false):', calendarInstanceAfterOff.isCommunityCalendar);

// (The 400 rejection for posting to a non-calendar instance, and
// isCommunityCalendar's independence from isCommunitySign, are covered by
// worker/index.test.js's own "Community calendar" describe block instead
// of here — same reasoning as community-signs.test.mjs's own note.)

const pass = labelBefore.trim() === 'Community Calendar' &&
  labelAfterOn.includes('✓') &&
  calendarInstance.isCommunityCalendar === true &&
  events.length === 2 &&
  events[0].text === 'Bonfire night, Friday 8pm!' &&
  rowCountInPanel === 2 &&
  firstRowText.includes('A Builder') && firstRowText.includes('Bonfire night') &&
  rowCountAfterDelete === 1 &&
  eventsAfterDelete.length === 1 && eventsAfterDelete[0].authorLabel === 'A Builder' &&
  scheduledRowText.includes('Scheduled for') &&
  notDueTrigger.body.triggered === false &&
  modalHiddenAfterUnflag &&
  labelAfterOff.trim() === 'Community Calendar' &&
  calendarInstanceAfterOff.isCommunityCalendar === false &&
  errors.length === 0;
await finish(browser, { pass, label: 'Community Calendar toggle + Manage Events panel + calendar-events API + scheduled events', errors });
