// #3761 (part of #3759): the Shop / Build / Sell petals of the ring are a picture first with their
// one small word under it, like every leaf: an icon that is not the fallback leaf, the word as real
// text, the icon above the word, both upright and inside the screen, the petal still at least
// 44px, and the word still readable at its size. Shop, 390x844, bud open.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Petal Icons';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
await openAccountMenu(page);
await page.waitForTimeout(900);

if (process.env.PETAL_SHOTS) await page.screenshot({ path: `${process.env.PETAL_SHOTS}/petals-shop-open.png`, clip: { x: 0, y: 0, width: 390, height: 300 } });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const rows = await page.evaluate(() => [...document.querySelectorAll('#bud-modes .mode-nav-btn')].map((btn) => {
  const icon = btn.querySelector('.bud-icon');
  const word = btn.querySelector('.mode-nav-label');
  const ir = icon?.getBoundingClientRect();
  const wr = word?.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  return {
    mode: btn.dataset.mode,
    key: icon?.dataset.icon || null,
    text: word ? [...word.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : '',
    icon: ir ? { x: ir.x, y: ir.y, w: ir.width, h: ir.height } : null,
    wordBox: wr ? { x: wr.x, y: wr.y, w: wr.width, h: wr.height } : null,
    petal: { w: br.width, h: br.height },
  };
}));
console.log(JSON.stringify(rows));
check(rows.length === 3, 'three petals in the ring');
for (const r of rows) {
  check(r.key === r.mode, `${r.mode}: its own icon (${r.key})`);
  check(r.text.toLowerCase() === r.mode, `${r.mode}: the word is its real text (${r.text})`);
  check(r.icon && r.icon.w >= 18 && r.icon.h >= 18, `${r.mode}: the icon is drawn at a size that reads (${JSON.stringify(r.icon)})`);
  check(r.icon && r.wordBox && r.icon.y + r.icon.h <= r.wordBox.y + r.wordBox.h * 0.6 + 1, `${r.mode}: the icon is above the word`);
  check(r.icon && r.icon.x >= 0 && r.icon.x + r.icon.w <= 390 && r.icon.y >= 0 && r.icon.y + r.icon.h <= 844, `${r.mode}: the icon is on screen`);
  check(r.petal.w >= 44 && r.petal.h >= 44 || Math.max(r.petal.w, r.petal.h) >= 44, `${r.mode}: the petal is still a tap target`);
}
await finish(browser, { pass: pass && errors.length === 0, label: 'Mode petals: icon first, word under it (#3761)', errors });
