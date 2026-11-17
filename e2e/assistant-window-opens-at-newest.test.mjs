// #3658 (part of #3624): the assistant window opens at the newest message, stays
// there as messages arrive, and leaves a reader who scrolled up where they are.
// The history is served by a stubbed GET /api/assistant-chat/current (the real
// endpoint is covered by worker/assistant-chat.test.js); the panel is real.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Newest Message Shopper';
const session = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
const page = session.page;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });

const history = Array.from({ length: 40 }, (_, i) => ({
  sender: i % 2 === 0 ? 'shopper' : 'assistant',
  text: `Message number ${i + 1}`,
  createdAt: new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString(),
  ...(i % 2 === 0 ? {} : { authorName: 'Juniper' }),
}));
await page.route('**/api/assistant-chat/current**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ conversation: null, messages: [], history, replyWaitSeconds: 90 }),
}));
// A question in line: the panel re-renders every five seconds while it waits.
let questionInLine = false;
await page.route('**/api/assistant-chat/question', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    question: questionInLine
      ? { questionId: 'q-stub', text: 'Is anyone there?', status: 'waiting', position: 1, createdAt: new Date().toISOString() }
      : null,
    assistantsOnShift: 1,
    keptDays: 7,
  }),
}));

const position = () => page.evaluate(() => {
  const log = document.getElementById('assistant-chat-log');
  const last = log.lastElementChild.getBoundingClientRect();
  const box = log.getBoundingClientRect();
  return {
    top: log.scrollTop, gap: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight),
    lastInView: last.bottom <= box.bottom + 1 && last.top >= box.top - 1, scrollable: log.scrollHeight > log.clientHeight + 40,
  };
});

await page.evaluate(() => document.getElementById('settings-assistant-btn').click());
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
await page.waitForFunction(() => window.__assistantChat?.history?.length >= 40, null, { timeout: 5000 });
await page.waitForTimeout(300);
const opened = await position();
console.log('opened:', JSON.stringify(opened));
check(opened.scrollable, 'the history is longer than the window (the test is meaningful)');
check(opened.gap <= 2 && opened.lastInView, 'it opens at the newest message');

// Again with a question in line (the panel re-renders every five seconds then).
await page.click('#assistant-chat-close');
await page.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });
questionInLine = true;
await page.evaluate(() => document.getElementById('settings-assistant-btn').click());
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
await page.waitForFunction(() => window.__assistantChat?.question?.status === 'waiting', null, { timeout: 5000 });
await page.waitForTimeout(300);
const withQuestion = await position();
console.log('opened with a question in line:', JSON.stringify(withQuestion));
check(withQuestion.gap <= 2 && withQuestion.lastInView, 'it opens at the newest with a question in line too');

// Scroll up to read, wait for the next re-render, and stay put.
await page.evaluate(() => { document.getElementById('assistant-chat-log').scrollTop = 0; });
await page.waitForTimeout(6500);
const held = await position();
console.log('after scrolling up and a re-render:', JSON.stringify(held));
check(held.top === 0, 'a reader who scrolled up is not pulled down by new content');

// Minimise and restore: back at the newest.
await page.click('#assistant-chat-minimize');
await page.click('#account-menu-toggle'); // #3653: no pill; the Assistant row behind the bud brings it back
await page.click('#assistant-menu-btn');
await page.waitForTimeout(300);
const restored = await position();
console.log('restored:', JSON.stringify(restored));
check(restored.gap <= 2 && restored.lastInView, 'restoring from the Assistant row returns to the newest message');

const errors = session.errors || [];
await finish(session.browser, { pass: pass && errors.length === 0, label: '#3658: the assistant window opens at the newest message and keeps a reader\'s place', errors });
