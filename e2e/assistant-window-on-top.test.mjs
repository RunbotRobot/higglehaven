// #3626: the assistant window is always in front. In Sell, My Products stays open
// behind it (so the person can ask about it), and nothing but the destructive
// confirmation, the age/ID verification and sign-in is allowed to paint over it,
// in any mode. Two checks, at phone width: (1) the real flow the owner hit (Sell,
// Settings, Ask an assistant, with My Products open) and what is at the centre of
// the assistant window; (2) the computed stacking of every fixed element in the
// page against the assistant window's, so a panel added later with a higher
// z-index fails here.
import { launchPage, chooseIdentity, openAccountMenu, openAssistantFromHelp, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Window On Top', viewport: { width: 390, height: 844 } });

// Sell mode opens My Products on arrival.
await chooseIdentity(page, { mode: 'sell', label: 'Window On Top', isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 15000 });

// The owner's path: the bud, "?", then Ask an assistant, with My Products open.
await openAssistantFromHelp(page);
await page.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(500);

const flow = await page.evaluate(() => {
  const panel = document.getElementById('assistant-chat-panel');
  const box = panel.getBoundingClientRect();
  const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const corners = [[box.left + 4, box.top + 4], [box.right - 4, box.top + 4], [box.left + 4, box.bottom - 4], [box.right - 4, box.bottom - 4]]
    .map(([x, y]) => document.elementFromPoint(x, y));
  return {
    sellerStillOpen: document.getElementById('seller-modal').classList.contains('visible'),
    centreInPanel: panel.contains(centre),
    cornersInPanel: corners.every((el) => el && panel.contains(el)),
    box: box.toJSON(),
    vw: window.innerWidth, vh: window.innerHeight,
  };
});
console.log('flow:', JSON.stringify({ ...flow, box: undefined }));

// Minimised (#3653: no pill; the account menu's Assistant row is the way back, and it is in front of
// My Products too), My Products is as it was.
await page.click('#assistant-chat-minimize').catch(() => {});
await page.waitForTimeout(300);
await openAccountMenu(page);
// The menu leaves unfurl for about half a second after it opens (the flower grows out of the bud), and
// a hit test taken while one is still moving can land beside it: wait for the row to hold still before
// asking what is on top of it. The answer asked for is the same; only when it is asked changes (a loaded
// CI runner failed this at the first read, #4113).
const readPill = () => page.evaluate(() => {
  const el = document.getElementById('assistant-menu-btn');
  if (!el || el.hidden) return { shown: false };
  const box = el.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return { shown: true, onTop: el.contains(hit), sellerStillOpen: document.getElementById('seller-modal').classList.contains('visible'), at: `${Math.round(box.left)},${Math.round(box.top)}` };
});
let pill = await readPill();
for (let i = 0; i < 12 && !(pill.shown && pill.onTop); i += 1) {
  await page.waitForTimeout(250);
  pill = await readPill();
}
delete pill.at;
console.log('pill:', JSON.stringify(pill));

// Every fixed element with a stacking level at or above the assistant window's.
const stacking = await page.evaluate(() => {
  const z = (el) => { const n = Number.parseInt(getComputedStyle(el).zIndex, 10); return Number.isNaN(n) ? null : n; };
  const panelZ = z(document.getElementById('assistant-chat-panel'));
  const pillZ = panelZ;
  const level = panelZ;
  const over = [];
  for (const el of document.querySelectorAll('body *')) {
    if (getComputedStyle(el).position !== 'fixed') continue;
    const value = z(el);
    if (value === null || value < level) continue;
    if (el.id === 'assistant-chat-panel') continue;
    if (el.closest('#assistant-chat-panel')) continue;
    over.push({ id: el.id || el.className || el.tagName, z: value });
  }
  return { panelZ, pillZ, level, over };
});
console.log('stacking:', JSON.stringify(stacking));
const ALLOWED_ABOVE = new Set(['confirm-modal', 'verify-modal', 'auth-modal']);
const unexpected = stacking.over.filter((entry) => !ALLOWED_ABOVE.has(entry.id));
const mustWinAbove = ['confirm-modal', 'verify-modal', 'auth-modal'].every((id) => stacking.over.some((entry) => entry.id === id && entry.z > stacking.level));

// The bud folds the My Products leaf when it opens (#3701), and the assistant is
// reached through the bud, so the list is no longer open behind it; the stacking
// check below is what keeps the window in front of it when it is.
const pass = flow.centreInPanel && flow.cornersInPanel
  && flow.box.left >= 0 && flow.box.right <= flow.vw && flow.box.bottom <= flow.vh
  && pill.shown && pill.onTop
  && stacking.panelZ === stacking.pillZ
  && unexpected.length === 0 && mustWinAbove
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3626: the assistant window and its way back are in front of My Products and every panel; only confirmation, verification and sign-in are above',
  errors,
});
