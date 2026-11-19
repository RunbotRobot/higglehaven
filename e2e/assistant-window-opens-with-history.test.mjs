// #3773: the assistant window is never shown empty while a person's history loads. With a slow
// thread fetch the tapped row stays marked busy and the window appears only once the thread is in
// it; with the thread already fetched (warmed when the "?" leaf opens) it appears at once and the
// newer copy arrives in place; when the history cannot be loaded the window opens and says so, with
// a way to try again. The endpoints are stubbed; the panel and the "?" leaf are real.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'History First Shopper';
const session = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
const page = session.page;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });

const history = Array.from({ length: 6 }, (_, i) => ({
  sender: i % 2 === 0 ? 'shopper' : 'assistant',
  text: `Earlier message ${i + 1}`,
  createdAt: new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString(),
  ...(i % 2 === 0 ? {} : { authorName: 'Juniper' }),
}));
let mode = 'slow'; // slow | fast | fail
let threadDelayMs = 1800;
let threadFetches = 0;
await page.route('**/api/assistant-chat/current**', async (route) => {
  threadFetches += 1;
  if (mode === 'fail') { await route.abort(); return; }
  await new Promise((resolve) => setTimeout(resolve, threadDelayMs));
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ conversation: null, messages: [], history, replyWaitSeconds: 90 }),
  });
});
await page.route('**/api/assistant-chat/question', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ question: null, assistantsOnShift: 1, keptDays: 7 }),
}));

// Records, the moment the window stops being hidden, how many rows it holds.
await page.evaluate(() => {
  const panel = document.getElementById('assistant-chat-panel');
  window.__shownWith = [];
  new MutationObserver(() => {
    if (!panel.hidden) {
      window.__shownWith.push(document.getElementById('assistant-chat-log').children.length);
    }
  }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
});

const openHelp = async () => {
  await openAccountMenu(page);
  await page.locator('#account-menu-panel button:visible', { hasText: /^Help$/ }).first().click();
  await page.waitForSelector('#help-ask-assistant-btn', { state: 'visible', timeout: 5000 });
};
const closeWindow = async () => {
  await page.click('#assistant-chat-close');
  await page.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });
};

// 1. A slow fetch with nothing fetched ahead: the tap is answered, the window waits for the thread.
await openHelp();
await page.waitForTimeout(100);
await page.click('#help-ask-assistant-btn');
await page.waitForTimeout(500);
const during = await page.evaluate(() => ({
  hidden: document.getElementById('assistant-chat-panel').hidden,
  working: document.body.classList.contains('assistant-opening'),
  busy: document.getElementById('help-ask-assistant-btn')?.getAttribute('aria-busy') === 'true',
}));
console.log('while the thread loads:', JSON.stringify(during));
check(during.hidden, 'the window is not shown while the thread has not arrived');
check(during.working, 'the page marks that the assistant is opening (cursor and the head breathe)');
check(during.busy, 'the tapped row is marked busy until the window appears');
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 6000 });
const shown1 = await page.evaluate(() => window.__shownWith.slice());
console.log('rows when first shown:', JSON.stringify(shown1));
check(shown1.length > 0 && shown1[0] >= history.length, 'when the window first appears the history is already in it');
check(await page.evaluate(() => !document.body.classList.contains('assistant-opening')), 'the working mark is gone once it is shown');
await closeWindow();

// 2. The thread was fetched ahead (the leaf warms it): the window is at once, then refreshed in place.
mode = 'fast';
threadDelayMs = 0;
await page.evaluate(() => { window.__shownWith = []; });
await openHelp();
await page.waitForTimeout(500); // the warm fetch lands
threadDelayMs = 1500; // the refresh on open is slow; what is shown must not wait for it
const fetchesBefore = threadFetches;
await page.click('#help-ask-assistant-btn');
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 800 });
const shown2 = await page.evaluate(() => window.__shownWith.slice());
console.log('rows when shown with the thread fetched ahead:', JSON.stringify(shown2), 'fetches:', threadFetches - fetchesBefore);
check(shown2.length > 0 && shown2[0] >= history.length, 'with the thread fetched ahead the window opens at once with it');
await page.waitForTimeout(2000);
check(await page.evaluate(() => window.__assistantChat.history.length) === history.length, 'the refreshed copy arrives in place');
await closeWindow();

// 3. The history cannot be loaded: the window says so, with a way to try again.
mode = 'fail';
// A fresh page, so there is no copy of the thread from earlier in this run.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await openHelp();
await page.click('#help-ask-assistant-btn');
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 6000 });
const failed = await page.evaluate(() => ({
  status: document.getElementById('assistant-chat-status').textContent,
  isError: document.getElementById('assistant-chat-status').classList.contains('error'),
  retryShown: !document.getElementById('assistant-chat-retry').hidden,
  selectable: getComputedStyle(document.getElementById('assistant-chat-status')).userSelect !== 'none',
}));
console.log('when the history cannot be loaded:', JSON.stringify(failed));
check(/couldn't load your conversation/i.test(failed.status) && failed.isError, 'it says plainly that the conversation could not be loaded');
check(failed.retryShown, 'it offers Try again');
check(failed.selectable, 'the sentence can be selected');
mode = 'fast';
threadDelayMs = 0;
await page.click('#assistant-chat-retry');
await page.waitForFunction(() => window.__assistantChat.history.length >= 6, null, { timeout: 5000 });
const retried = await page.evaluate(() => ({
  retryShown: !document.getElementById('assistant-chat-retry').hidden,
  status: document.getElementById('assistant-chat-status').textContent,
}));
check(!retried.retryShown && retried.status === '', 'Try again brings the conversation in and clears the sentence');

const errors = (session.errors || []).filter((e) => !/Failed to load resource|net::ERR/i.test(String(e)));
await finish(session.browser, { pass: pass && errors.length === 0, label: '#3773: the assistant window opens with its conversation in it', errors });
