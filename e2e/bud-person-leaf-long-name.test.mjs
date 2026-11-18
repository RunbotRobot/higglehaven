// #3761 (part of #3759): the Person leaf shows the account's name as its one small word. A long
// name stays on one line and is cut at the leaf's edge, never broken mid-word ("higglehaven1" over
// "0", seen live on a fleet account). Shop, 390x844.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'A Very Long Account Name Indeed';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
await openAccountMenu(page);
await page.waitForTimeout(800);

const m = await page.evaluate(() => {
  const b = document.getElementById('account-auth-btn');
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  const icon = b.querySelector('.bud-icon');
  return { text: b.textContent.trim(), h: r.height, w: r.width, lineH: parseFloat(cs.lineHeight) || 14, overflow: cs.textOverflow, nowrap: cs.whiteSpace === 'nowrap', iconH: icon ? icon.getBoundingClientRect().height : 0, scrollW: b.scrollWidth, clientW: b.clientWidth };
});
console.log(JSON.stringify(m));
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
check(!/log in|sign up/i.test(m.text) && m.text.length > 12, `the leaf carries a long name (${m.text})`);
check(m.nowrap && m.overflow === 'ellipsis', 'the name is one line, cut with an ellipsis');
check(m.h < m.iconH + m.lineH * 2 + 24, `the leaf is one word line tall, not wrapped (height ${Math.round(m.h)})`);
check(m.w <= 80, `the leaf keeps its width (${Math.round(m.w)})`);
await finish(browser, { pass: pass && errors.length === 0, label: 'Person leaf: a long account name is cut, not wrapped (#3761)', errors });
