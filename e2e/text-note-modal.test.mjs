// #3359: Shop's sign-post note and calendar event are one in-app modal
// (src/ui/textNoteModal.js), not chains of native prompt()/alert(). The real
// in-world hints need real camera movement, so this opens the modal directly
// with stubbed callbacks (the sign flows themselves are covered end to end by
// community-sign-stale-post-recovery and community-sign-edit-char-limit-guard)
// and dismisses every native dialog the instant it opens, which is what a
// suppressed dialog does. Covers: create with a live count, an empty note and
// an over-long note refused inside the modal with the typed text kept, a
// server error shown inside it and a working retry, the calendar's optional
// date/time (sent as an ISO instant, or omitted when empty), and edit mode's
// prefill and Delete through the destructive-confirm modal.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Text Note Modal Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
const nativeDialogs = [];
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs.push(dialog.type());
  await dialog.dismiss();
});
const visible = (sel) => page.evaluate((s) => document.querySelector(s)?.classList.contains('visible') ?? false, sel);

// --- create: empty and over-long refused in the modal, a server error shown, retry works ---
await page.evaluate(() => {
  window.__noteCalls = [];
  window.__noteResult = undefined;
  window.__failNext = true;
  window.__openTextNoteModal({
    title: 'Leave a note on this sign',
    label: 'Note',
    submitLabel: 'Post note',
    emptyMessage: 'Write a note first.',
    onSubmit: async (payload) => {
      window.__noteCalls.push(payload);
      if (window.__failNext) { window.__failNext = false; throw new Error('Too many notes on this sign.'); }
    },
  }).then((r) => { window.__noteResult = r; });
});
await page.waitForSelector('#note-modal.visible', { timeout: 5000 });
const createTitle = await page.textContent('#note-modal-title');
const scheduleHiddenOnSign = !(await page.isVisible('#note-modal-schedule'));
const deleteHiddenOnCreate = !(await page.isVisible('#note-modal-delete-btn'));
await page.click('#note-modal-save-btn');
await page.waitForSelector('#note-modal-status:not([hidden])', { timeout: 5000 });
const emptyMsg = await page.textContent('#note-modal-status');
await page.fill('#note-modal-text', 'x'.repeat(281));
const countText = await page.textContent('#note-modal-count');
const countOver = await page.$eval('#note-modal-count', (el) => el.classList.contains('over'));
await page.click('#note-modal-save-btn');
const overMsg = await page.textContent('#note-modal-status');
const callsBeforeValid = await page.evaluate(() => window.__noteCalls.length);
await page.fill('#note-modal-text', 'Hello from the sign');
await page.click('#note-modal-save-btn');
await page.waitForFunction(() => window.__noteCalls.length === 1, null, { timeout: 5000 });
await page.waitForFunction(() => document.getElementById('note-modal-status').textContent.includes('Too many notes'), null, { timeout: 5000 });
const stillOpenAfterError = await visible('#note-modal');
const keptAfterError = (await page.inputValue('#note-modal-text')) === 'Hello from the sign';
await page.click('#note-modal-save-btn');
await page.waitForFunction(() => window.__noteResult === true, null, { timeout: 5000 });
const noteCalls = await page.evaluate(() => window.__noteCalls);

// --- calendar: optional date/time becomes an ISO instant, or is omitted ---
await page.evaluate(() => {
  window.__eventCalls = [];
  window.__noteResult = undefined;
  window.__openTextNoteModal({
    title: 'Add an event to this calendar', label: 'Event details', schedule: true, submitLabel: 'Post event',
    onSubmit: async (payload) => { window.__eventCalls.push(payload); },
  }).then((r) => { window.__noteResult = r; });
});
await page.waitForSelector('#note-modal.visible', { timeout: 5000 });
const scheduleShownOnCalendar = await page.isVisible('#note-modal-schedule');
await page.fill('#note-modal-text', 'Opening party');
await page.fill('#note-modal-schedule', '2026-12-24T20:30');
await page.click('#note-modal-save-btn');
await page.waitForFunction(() => window.__noteResult === true, null, { timeout: 5000 });
await page.evaluate(() => {
  window.__noteResult = undefined;
  window.__openTextNoteModal({
    title: 'Add an event to this calendar', label: 'Event details', schedule: true,
    onSubmit: async (payload) => { window.__eventCalls.push(payload); },
  }).then((r) => { window.__noteResult = r; });
});
await page.waitForSelector('#note-modal.visible', { timeout: 5000 });
const scheduleResetBetweenOpens = (await page.inputValue('#note-modal-schedule')) === '';
await page.fill('#note-modal-text', 'Just an announcement');
await page.click('#note-modal-save-btn');
await page.waitForFunction(() => window.__noteResult === true, null, { timeout: 5000 });
const eventCalls = await page.evaluate(() => window.__eventCalls);

// --- edit: prefilled; Never mind deletes nothing; confirm deletes once ---
await page.evaluate(() => {
  window.__deleted = 0;
  window.__noteResult = undefined;
  window.__openTextNoteModal({
    title: 'Your note on this sign', existing: { text: 'My old note' },
    onSubmit: async () => {}, onDelete: async () => { window.__deleted += 1; },
  }).then((r) => { window.__noteResult = r; });
});
await page.waitForSelector('#note-modal.visible', { timeout: 5000 });
const editPrefill = await page.inputValue('#note-modal-text');
const deleteShownOnEdit = await page.isVisible('#note-modal-delete-btn');
await page.click('#note-modal-delete-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-cancel-btn');
await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
const stillOpenAfterNeverMind = await visible('#note-modal');
const deletedAfterNeverMind = await page.evaluate(() => window.__deleted);
await page.click('#note-modal-delete-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(() => window.__noteResult === true, null, { timeout: 5000 });
const deletedAfterConfirm = await page.evaluate(() => window.__deleted);
const bothClosed = !(await visible('#note-modal')) && !(await visible('#confirm-modal'));

console.log({ createTitle, scheduleHiddenOnSign, deleteHiddenOnCreate, emptyMsg, countText, countOver, overMsg, callsBeforeValid, stillOpenAfterError, keptAfterError, noteCalls, scheduleShownOnCalendar, scheduleResetBetweenOpens, eventCalls, editPrefill, deleteShownOnEdit, stillOpenAfterNeverMind, deletedAfterNeverMind, deletedAfterConfirm, bothClosed, nativeDialogs });

const pass = createTitle === 'Leave a note on this sign' && scheduleHiddenOnSign && deleteHiddenOnCreate &&
  emptyMsg === 'Write a note first.' && countText === '281/280' && countOver && /280/.test(overMsg) && callsBeforeValid === 0 &&
  stillOpenAfterError && keptAfterError && noteCalls.length === 2 && noteCalls[1].text === 'Hello from the sign' && noteCalls[1].scheduledAt === undefined &&
  scheduleShownOnCalendar && scheduleResetBetweenOpens &&
  eventCalls.length === 2 && eventCalls[0].text === 'Opening party' && eventCalls[0].scheduledAt === new Date('2026-12-24T20:30').toISOString() &&
  eventCalls[1].text === 'Just an announcement' && eventCalls[1].scheduledAt === undefined &&
  editPrefill === 'My old note' && deleteShownOnEdit && stillOpenAfterNeverMind && deletedAfterNeverMind === 0 && deletedAfterConfirm === 1 && bothClosed &&
  nativeDialogs.length === 0 && errors.length === 0;
await finish(browser, { pass, label: '#3359: sign note and calendar event are an in-app modal (count, refusals kept in the modal, optional date, delete via confirm), no native dialogs', errors });
