// #4138 (part of #3818): under prefers-reduced-motion nothing in the flower loops. The head's first-visit
// pulse and the pulse while the assistant window opens name the head by its id, so they outranked the
// rule that stops the head's animation and kept looping. With reduced motion on, force each state the
// head can be in and assert that no animation on the page repeats forever.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Reduced Motion Tester', viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: 'Reduced Motion Tester', isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await page.waitForTimeout(2500); // the opening screen has lifted

// What loops: every running animation on the page whose iterations never end.
const loops = () => page.evaluate(() => document.getAnimations()
  .filter((a) => a.effect && a.effect.getComputedTiming().iterations === Infinity)
  .map((a) => `${a.animationName || a.transitionProperty || 'animation'} on ${a.effect.target?.id || a.effect.target?.className || a.effect.target?.tagName}`));

// Without reduced motion the first-visit pulse does loop, so the check below can fail.
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.evaluate(() => document.body.setAttribute('data-bud-new', ''));
await page.waitForTimeout(300);
check((await loops()).some((n) => n.startsWith('bud-head-pulse')), `without reduced motion the first-visit head pulses (got ${JSON.stringify(await loops())})`);

await page.emulateMedia({ reducedMotion: 'reduce' });
await page.waitForTimeout(300);
check((await loops()).length === 0, `first visit, closed: nothing loops under reduced motion (got ${JSON.stringify(await loops())})`);
check((await page.evaluate(() => getComputedStyle(document.querySelector('#account-menu-toggle .bud-logo')).filter)) !== 'none', 'the first-visit head still stands out, still');

await page.evaluate(() => { document.body.removeAttribute('data-bud-new'); document.body.classList.add('assistant-opening'); });
await page.waitForTimeout(300);
check((await loops()).length === 0, `the assistant window opening: nothing loops under reduced motion (got ${JSON.stringify(await loops())})`);
await page.evaluate(() => document.body.classList.remove('assistant-opening'));

await page.click('#account-menu-toggle');
await page.waitForTimeout(1200);
check((await loops()).length === 0, `menu open: nothing loops under reduced motion (got ${JSON.stringify(await loops())})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#4138: nothing in the flower loops under reduced motion', errors });
