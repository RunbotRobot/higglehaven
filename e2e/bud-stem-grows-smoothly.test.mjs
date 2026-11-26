// #4431: the stem drew down in about four frames and overshot its end (the bloom curve on a long line), which
// read as steps. Sampled every frame while the flower opens, the stem's dash offset falls from 1 to 0 in many
// small, even moves and never goes below 0.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Stem Smooth', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: 'Stem Smooth', isNew: true });
await page.waitForTimeout(1500);
const samples = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  document.getElementById('account-menu-toggle').click();
  await new Promise((resolve) => {
    function tick() {
      const path = document.querySelector('#bud-stem .bud-stem-core');
      if (path) out.push(parseFloat(getComputedStyle(path).strokeDashoffset));
      if (performance.now() - t0 < 900) requestAnimationFrame(tick); else resolve();
    }
    requestAnimationFrame(tick);
  });
  return out;
});
const moving = samples.filter((v) => v < 0.999 && v > 0.001);
const overshoot = samples.some((v) => v < -0.001);
// the biggest single-frame move among the frames that are drawing it
let biggest = 0;
for (let i = 1; i < samples.length; i++) biggest = Math.max(biggest, Math.abs(samples[i] - samples[i - 1]));
console.log('frames drawing the stem:', moving.length, 'overshoot:', overshoot, 'biggest frame move:', biggest.toFixed(3));
const pass = moving.length >= 6 && !overshoot && biggest < 0.35 && samples[samples.length - 1] === 0;
await finish(browser, { pass, label: '#4431: the stem draws down in one even motion', errors });
