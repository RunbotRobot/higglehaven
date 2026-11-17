// #3572 (part of #3539, Build mode audit), kept for the Levels leaf (#3690): the level controls
// open clear of the bottom-left tool stack (Paste, Measure, Multi-Select) on a
// phone, and inside the screen. They used to be a dropdown from the "Ground" pill that
// reached back over those tools; now they are a leaf of the bud.
import { launchPage, chooseIdentity, claimLandlet, finish, openLevelMenu } from './helpers.mjs';

const LABEL = 'Level Menu Clear Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

await openLevelMenu(page);
await page.waitForTimeout(500);

const boxes = await page.evaluate(() => {
  const rect = (selector) => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  return {
    leaf: rect('#bud-leaf-levels'),
    tools: ['#paste-btn', '#toggle-measure', '#toggle-multiselect'].map((id) => ({ id, ...rect(id) })),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
});
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const covered = boxes.tools.filter((tool) => tool.right > tool.left && overlaps(boxes.leaf, tool)).map((tool) => tool.id);
const onScreen = boxes.leaf.left >= 0 && boxes.leaf.right <= boxes.vw && boxes.leaf.top >= 0 && boxes.leaf.bottom <= boxes.vh;
console.log('leaf:', JSON.stringify(boxes.leaf), 'covers tools:', JSON.stringify(covered), 'on screen:', onScreen);

const pass = covered.length === 0 && onScreen && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3572: the level controls open clear of the Build tool stack and inside the screen',
  errors,
});
