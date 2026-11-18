// #3567 (interface week, found in the Shop audit #3544): the two utilities at
// the foot of Settings, "Ask an assistant" and "Send feedback", are siblings
// and look like siblings. "Send feedback" used to be a rounded pill while
// "Ask an assistant" fell back to the browser's square default button.
// Opens Settings at phone width and compares what each is drawn with, and
// that the two do not overlap or run off the panel.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Utilities Style Tester', viewport: { width: 390, height: 844 } });

await chooseIdentity(page, { mode: 'shop', label: 'Utilities Style Tester', isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });

const measure = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const panel = document.getElementById('settings-modal').getBoundingClientRect();
  return {
    borderRadius: cs.borderTopLeftRadius,
    borderWidth: cs.borderTopWidth,
    borderColor: cs.borderTopColor,
    background: cs.backgroundColor,
    color: cs.color,
    fontSize: cs.fontSize,
    height: Math.round(r.height),
    left: r.left, right: r.right, top: r.top,
    insidePanel: r.left >= panel.left && r.right <= panel.right,
  };
}, selector);

const assistant = await measure('#settings-assistant-btn');
const feedback = await measure('#settings-feedback-btn');
console.log('assistant:', JSON.stringify(assistant));
console.log('feedback:', JSON.stringify(feedback));

const sameLook = ['borderRadius', 'borderWidth', 'borderColor', 'background', 'color', 'fontSize', 'height']
  .every((key) => assistant[key] === feedback[key]);
const isPill = parseFloat(assistant.borderRadius) >= assistant.height / 2;
const sideBySide = Math.abs(assistant.top - feedback.top) < 2;
const noOverlap = !sideBySide || assistant.right <= feedback.left || feedback.right <= assistant.left;
const pass = sameLook && isPill && noOverlap && assistant.insidePanel && feedback.insidePanel && errors.length === 0;
console.log(JSON.stringify({ sameLook, isPill, noOverlap, inside: [assistant.insidePanel, feedback.insidePanel] }));
await finish(browser, { pass, label: 'settings-utilities-one-style (#3567)', errors });
