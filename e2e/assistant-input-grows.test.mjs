// #3750 (owner request, 2026-11-18): the assistant window's message box starts one line tall
// and grows with the text (up to about five lines, then scrolls inside), Send stays level with
// its bottom, a person who reaches the server's limit is told the number beside the box, and
// the box returns to one line after the text is cleared. The panel is opened through the same
// click handler Settings > Ask an assistant uses, with no conversation, as the sibling
// assistant-panel e2e does.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Input Grows Shopper';
const session = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
const page = session.page;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await page.evaluate(() => document.getElementById('settings-assistant-btn').click());
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });

const geometry = () => page.evaluate(() => {
  const input = document.getElementById('assistant-chat-input');
  const send = document.getElementById('assistant-chat-send');
  const line = parseFloat(getComputedStyle(input).lineHeight);
  return {
    tag: input.tagName,
    height: input.getBoundingClientRect().height,
    inputBottom: input.getBoundingClientRect().bottom,
    sendBottom: send.getBoundingClientRect().bottom,
    scrolls: input.scrollHeight > input.clientHeight + 1,
    line,
    limitShown: !document.getElementById('assistant-chat-limit').hidden,
    limitText: document.getElementById('assistant-chat-limit').textContent,
    value: input.value.length,
  };
});

const rest = await geometry();
check(rest.tag === 'TEXTAREA', `the message box is a text area (${rest.tag})`);
check(rest.height < rest.line * 2.5, `it starts about one line tall (${rest.height}px, line ${rest.line}px)`);
check(!rest.limitShown, 'no limit note while the box is short');

await page.focus('#assistant-chat-input');
await page.fill('#assistant-chat-input', 'First line.\nSecond line.\nThird line.');
const three = await geometry();
check(three.height > rest.height + rest.line, `three lines make the box taller (${rest.height}px -> ${three.height}px)`);
check(Math.abs(three.sendBottom - three.inputBottom) < 2, `Send stays level with the bottom of the box (${three.sendBottom} vs ${three.inputBottom})`);

await page.fill('#assistant-chat-input', Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n'));
const many = await geometry();
check(many.height <= rest.line * 5 + 40, `twelve lines are capped at about five (${many.height}px, line ${many.line}px)`);
check(many.scrolls, 'past the cap the box scrolls inside');

// The server's own limit, from one definition: the box stops there and says so.
const limit = await page.evaluate(() => document.getElementById('assistant-chat-input').maxLength);
check(limit === 280, `the box takes the server's limit (${limit})`);
await page.fill('#assistant-chat-input', 'x'.repeat(300));
const full = await geometry();
check(full.value === 280, `typing past the limit stops at it (${full.value})`);
check(full.limitShown && full.limitText.includes('280'), `a person at the limit is told the number (${JSON.stringify(full.limitText)})`);

// On a phone (touch) the keyboard's Enter adds a line; it does not send.
await page.fill('#assistant-chat-input', 'one');
const enter = await page.evaluate(() => new Promise((resolve) => {
  const input = document.getElementById('assistant-chat-input');
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  resolve({ prevented: event.defaultPrevented, fine: window.matchMedia('(pointer: fine)').matches });
}));
if (!enter.fine) check(!enter.prevented, 'with a touch keyboard Enter is left to add a line');

// Clearing returns the box to one line and removes the note.
await page.fill('#assistant-chat-input', '');
await page.evaluate(() => document.getElementById('assistant-chat-input').dispatchEvent(new Event('input', { bubbles: true })));
const cleared = await geometry();
check(cleared.height < rest.line * 2.5, `an empty box is one line again (${cleared.height}px)`);
check(!cleared.limitShown, 'the limit note is gone');

await finish(session.browser, { pass, label: '#3750: the assistant message box grows with the text, tells the limit, and shrinks back', errors: session.errors });
