// #3572 (part of #3539, Build mode audit): the level menu opens clear of the
// bottom-left tool stack (Paste, Measure, Multi-Select, + Add Item) on a phone.
// It used to be centred on the "Ground" pill, which put its left edge over them.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Level Menu Clear Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

await page.click('#level-menu-toggle');
await page.waitForSelector('#level-menu-panel.expanded', { timeout: 5000 });
await page.waitForTimeout(300);

const boxes = await page.evaluate(() => {
  const rect = (selector) => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  return {
    panel: rect('#level-menu-panel'),
    tools: ['#paste-btn', '#toggle-measure', '#toggle-multiselect'].map((id) => ({ id, ...rect(id) })),
    vw: window.innerWidth,
  };
});
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const covered = boxes.tools.filter((tool) => overlaps(boxes.panel, tool)).map((tool) => tool.id);
const onScreen = boxes.panel.left >= 0 && boxes.panel.right <= boxes.vw;
console.log('panel:', JSON.stringify(boxes.panel), 'covers tools:', JSON.stringify(covered), 'on screen:', onScreen);

const pass = covered.length === 0 && onScreen && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3572: the level menu opens clear of the Build tool stack and inside the screen',
  errors,
});
