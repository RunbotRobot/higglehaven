// #3572: on a phone, the level menu (opened from the bottom-centre "Ground"
// pill) was centred on the pill and reached about x=85, lying on top of the
// bottom-left stack (Paste, Measure, Multi-Select, + Add Item). It must open
// clear of every one of those buttons and stay inside the screen.
import { launchPage, chooseIdentity, claimLandlet, openLevelMenu, finish } from './helpers.mjs';

const LABEL = 'Level Menu Layout Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);
await openLevelMenu(page);

const report = await page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const panelRect = rect(document.getElementById('level-menu-panel'));
  const overlaps = [];
  for (const id of ['paste-btn', 'toggle-measure', 'toggle-multiselect', 'add-item-btn']) {
    const el = document.getElementById(id);
    if (!el || el.offsetParent === null) continue;
    const r = rect(el);
    const hit = r.l < panelRect.r && r.r > panelRect.l && r.t < panelRect.b && r.b > panelRect.t;
    if (hit) overlaps.push(id);
  }
  return { panelRect, overlaps, viewportWidth: window.innerWidth };
});
console.log('level menu panel:', JSON.stringify(report));

const pass = report.overlaps.length === 0 &&
  report.panelRect.l >= 0 && report.panelRect.r <= report.viewportWidth &&
  errors.filter((e) => !e.includes('Failed to load resource')).length === 0;
await finish(browser, { pass, label: 'The level menu opens clear of the Build buttons and inside the screen (#3572)', errors });
