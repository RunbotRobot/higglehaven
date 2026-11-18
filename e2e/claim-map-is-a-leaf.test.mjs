// #3811 (part of #3654, the bud): the claim map is one large leaf of the bud, not a modal.
// A builder with no lándlet entering Build still lands on the claim step (it is the gate), but the
// step is a soft sheet from the head's corner with no scrim over the world, kept to the
// screen's width and height at phone size, with the same map, legend, Claim, Refresh and
// close button in the sheet's upper right.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Claim Leaf Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
await page.waitForTimeout(600);

const shape = await page.evaluate(() => {
  const modal = document.getElementById('claim-modal');
  const box = document.getElementById('claim-modal-content').getBoundingClientRect();
  const close = document.getElementById('claim-back-btn').getBoundingClientRect();
  const style = getComputedStyle(modal);
  const rect = modal.getBoundingClientRect();
  return {
    background: style.backgroundColor,
    modalWidth: rect.width,
    modalHeight: rect.height,
    box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
    close: { right: close.right, top: close.top },
    vw: window.innerWidth,
    vh: window.innerHeight,
    ids: ['claim-map-canvas', 'claim-legend', 'claim-confirm-btn', 'claim-refresh-btn', 'claim-status']
      .filter((id) => !document.getElementById(id)),
    scrimOverWorld: document.elementFromPoint(window.innerWidth - 4, window.innerHeight - 4)?.closest('#claim-modal') !== null,
  };
});
console.log(JSON.stringify(shape));
check(shape.background === 'rgba(0, 0, 0, 0)' || shape.background === 'transparent', `no scrim behind the sheet (background ${shape.background})`);
check(!shape.scrimOverWorld, 'the sheet does not cover the whole screen: the world shows at the corner');
check(shape.box.left >= 8 && shape.box.right <= shape.vw - 8, 'the sheet fits the screen width with a margin each side');
check(shape.box.bottom <= shape.vh - 8, 'the sheet fits the screen height (it scrolls inside if needed)');
check(shape.box.top >= 60, 'the sheet starts below the head, like every leaf');
check(shape.close.right > shape.box.right - 20 && shape.close.top < shape.box.top + 20, 'the close button stays in the sheet\'s upper-right corner');
check(shape.ids.length === 0, `the same map, legend, Claim, Refresh and status are in it (missing: ${shape.ids.join(', ') || 'none'})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#3811: the claim map is one large leaf with no scrim', errors });
