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
    // #4026: the stem is two paths in one svg (a pale edge under a green core), drawn from the head's own centre line.
    const core = document.querySelector('#bud-stem .bud-stem-core');
    const stemStyle = core ? getComputedStyle(core) : null;
    const overlaps = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (overlap(rows[i].box, rows[j].box)) overlaps.push([rows[i].id, rows[j].id]);
    const head = document.getElementById('account-menu-toggle').getBoundingClientRect();
    const box = core ? core.getBoundingClientRect() : null;
    const lastLeaf = rows[rows.length - 1].box;
    return {
      rows, overlaps, vw: innerWidth, vh: innerHeight,
      stemWidth: stemStyle ? parseFloat(stemStyle.strokeWidth) : 0,
      stemColor: stemStyle ? stemStyle.stroke : '',
      stemTop: box ? box.top : -1,
      stemLeft: box ? box.left : -1,
      stemBottom: box ? box.bottom : -1,
      stemRight: box ? box.right : -1,
      // #4200: the head points down and to the right, so the stem enters it at its base, at the upper left
      headBaseY: head.top + head.height * 0.19,
      headBaseX: head.left + head.width * 0.19,
      lastTip: lastLeaf.top + 6,
      firstTop: rows[0].box.top,
    };
  });
  console.log(`${label}:`, JSON.stringify(report.rows.map((r) => `${r.side}:${r.id}`)));
  check(report.rows.length >= 3, `${label}: the menu has leaves (${report.rows.length})`);
  check(report.stemWidth >= 6, `${label}: a stem is drawn, clearly thicker than a hairline (${report.stemWidth})`);
  check(/^rgb\(108, 164, 46\)$/.test(report.stemColor), `${label}: the stem is the brand green (${report.stemColor})`);
  report.rows.forEach((row, i) => {
    check(row.side === (i % 2 === 0 ? 'right' : 'left'), `${label}: leaf ${row.id} alternates (${row.side} at ${i})`);
    check(row.icons.every((n) => n === 1), `${label}: ${row.id} has one icon (${row.icons})`);
    check(row.kinds.every((k) => k && k !== 'leaf'), `${label}: ${row.id} has its own picture, not the plain-leaf fallback (${row.kinds})`);
    check(row.words.every((w) => w.length > 0), `${label}: ${row.id} has its word (${row.words})`);
    check(row.iconSize.every((s, k) => s >= 24 && s > row.wordSize[k] * 1.5), `${label}: ${row.id} icon is the main thing (${row.iconSize} vs ${row.wordSize})`);
    check(row.tap.every(([w, h]) => w >= 44 && h >= 44), `${label}: ${row.id} tap size ${JSON.stringify(row.tap)}`);
    check(row.box.left >= 0 && row.box.right <= report.vw && row.box.bottom <= report.vh, `${label}: ${row.id} is on the screen`);
  });
  // #4432: the top of the stem curls into the base: it rises beside the head, a little left of the base, and arcs
  // over to meet it (so its box starts a few px above and left of the base, never far from it, and never straight
  // up the base's own line).
  check(report.stemTop <= report.headBaseY + 2 && report.stemTop >= report.headBaseY - 8
    && report.stemLeft <= report.headBaseX - 3 && report.stemLeft >= report.headBaseX - 16,
  `${label}: the stem curls into the head at its base, the upper left (top ${report.stemTop}, left ${report.stemLeft}; base ${report.headBaseY}, ${report.headBaseX})`);
  check(Math.abs(report.stemBottom - report.lastTip) <= 2, `${label}: the stem ends at the last leaf's tip (${report.stemBottom} vs ${report.lastTip})`);
  // #4200: every leaf joins the stem at its tip: a right leaf's left edge, a left leaf's right edge, is on the stem's line.
  for (const row of report.rows) {
    const edge = row.side === 'right' ? row.box.left : row.box.right;
    check(Math.abs(edge - report.stemRight) <= 3, `${label}: ${row.id} (${row.side}) meets the stem at its tip (edge ${edge}, stem ${report.stemRight})`);
  }
  check(report.stemRight > report.stemLeft + 20 && report.stemTop < report.firstTop, `${label}: it curves across to the leaves' line above the first leaf`);
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
