// #3761 (part of #3759, the flower): an open menu is a stem with leaves on both sides, and every
// leaf is an icon with its one small word under it. At phone size, in Shop, Build and Sell:
// each visible leaf carries an inline icon and its word, the leaves alternate right and left of
// the stem, every leaf is at least 44px each way, inside the screen, and no two leaves overlap.
// STILLS_DIR (optional) saves a screenshot of each open menu for the PR.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, goToMode, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Stem Tester', viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
await chooseIdentity(page, { mode: 'build', label: 'Stem Tester', isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

async function inspect(label) {
  await openAccountMenu(page);
  await page.waitForTimeout(700); // the unfold is under half a second
  const report = await page.evaluate(() => {
    const panel = document.getElementById('account-menu-panel');
    const rect = (el) => el.getBoundingClientRect().toJSON();
    const leaves = [...panel.children].filter((el) => el.matches('button, .bud-pair') && !el.hidden && el.offsetParent !== null);
    const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const rows = leaves.map((el) => {
      const buttons = el.matches('.bud-pair') ? [...el.querySelectorAll('button')] : [el];
      return {
        id: el.id || '(pair)',
        side: el.dataset.side,
        box: rect(el),
        icons: buttons.map((b) => b.querySelectorAll(':scope > .bud-icon svg').length),
        kinds: buttons.map((b) => b.querySelector(':scope > .bud-icon')?.dataset.icon),
        words: buttons.map((b) => b.textContent.trim()),
        iconSize: buttons.map((b) => { const s = b.querySelector(':scope > .bud-icon svg'); return s ? s.getBoundingClientRect().height : 0; }),
        wordSize: buttons.map((b) => parseFloat(getComputedStyle(b).fontSize)),
        tap: buttons.map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }),
      };
    });
    const stem = getComputedStyle(panel, '::before');
    const overlaps = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (overlap(rows[i].box, rows[j].box)) overlaps.push([rows[i].id, rows[j].id]);
    // #4016: the stem's top edge is the panel's top less --stem-rise; it must reach the head (its middle, behind the petals).
    const head = document.getElementById('account-menu-toggle').getBoundingClientRect();
    const stemTop = panel.getBoundingClientRect().top - parseFloat(stem.top ? getComputedStyle(panel).getPropertyValue('--stem-rise') || '0' : '0');
    return { rows, overlaps, stemWidth: stem.width, stemContent: stem.content, vw: innerWidth, vh: innerHeight, stemTop, headMiddle: head.top + head.height / 2 };
  });
  console.log(`${label}:`, JSON.stringify(report.rows.map((r) => `${r.side}:${r.id}`)));
  check(report.rows.length >= 3, `${label}: the menu has leaves (${report.rows.length})`);
  check(report.stemContent !== 'none' && parseFloat(report.stemWidth) >= 2, `${label}: a stem is drawn (${report.stemWidth})`);
  report.rows.forEach((row, i) => {
    check(row.side === (i % 2 === 0 ? 'right' : 'left'), `${label}: leaf ${row.id} alternates (${row.side} at ${i})`);
    check(row.icons.every((n) => n === 1), `${label}: ${row.id} has one icon (${row.icons})`);
    check(row.kinds.every((k) => k && k !== 'leaf'), `${label}: ${row.id} has its own picture, not the plain-leaf fallback (${row.kinds})`);
    check(row.words.every((w) => w.length > 0), `${label}: ${row.id} has its word (${row.words})`);
    check(row.iconSize.every((s, k) => s >= 24 && s > row.wordSize[k] * 1.5), `${label}: ${row.id} icon is the main thing (${row.iconSize} vs ${row.wordSize})`);
    check(row.tap.every(([w, h]) => w >= 44 && h >= 44), `${label}: ${row.id} tap size ${JSON.stringify(row.tap)}`);
    check(row.box.left >= 0 && row.box.right <= report.vw && row.box.bottom <= report.vh, `${label}: ${row.id} is on the screen`);
  });
  check(Math.abs(report.stemTop - report.headMiddle) <= 2, `${label}: the stem grows from the head (top ${report.stemTop}, head middle ${report.headMiddle})`);
  check(report.overlaps.length === 0, `${label}: no two leaves overlap (${JSON.stringify(report.overlaps)})`);
  if (process.env.STILLS_DIR) await page.screenshot({ path: `${process.env.STILLS_DIR}/stem-${label}.png` });
  // Fold it again so the next mode starts from rest.
  await page.click('#account-menu-toggle');
  await page.waitForTimeout(300);
}

await inspect('build');
await goToMode(page, 'shop');
await page.waitForSelector('body.shop-ready', { timeout: 20000 });
await page.waitForTimeout(1500);
await inspect('shop');
await goToMode(page, 'sell');
await page.waitForTimeout(1500);
await inspect('sell');

await finish(browser, { pass, label: '#3761: an open menu is a stem with alternating icon leaves, each with its word, in Shop, Build and Sell', errors });
