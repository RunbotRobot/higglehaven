// #3738 (part of #3735): the opening screen is alive and tells the truth. While
// the app waits for someone to sign in, the bar sits at the stage reached (never
// on a timer), the words say what is being waited on, and a tip is showing and
// changes; once the world is up the screen lifts with the bar full; and when the
// world cannot be fetched the screen stays up with a sentence a person can select
// and a Try again that works.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';
import { LOADING_TIPS } from '../src/ui/loadingTips.js';

const LABEL = 'Opening Screen Tester';
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });

const read = () => page.evaluate(() => {
  const el = document.getElementById('loading-screen');
  return {
    exists: Boolean(el),
    progress: el ? Number(el.style.getPropertyValue('--loading-progress')) : null,
    stage: document.getElementById('loading-stage')?.textContent ?? '',
    tip: document.getElementById('loading-tip')?.textContent ?? '',
    hidden: el ? el.classList.contains('loading-screen-hidden') : null,
    failed: el ? el.classList.contains('loading-screen-failed') : null,
    opacity: el ? Number(getComputedStyle(el).opacity) : null,
    animating: [...document.querySelectorAll('.loading-petal')].some((p) => getComputedStyle(p).animationName !== 'none'),
  };
});

// 1. Signed out: the page is waiting on a sign-in, and says so.
await page.waitForSelector('#auth-modal.visible', { timeout: 10000 });
const waiting = await read();
console.log('while waiting for sign-in:', waiting);
const tipsText = LOADING_TIPS.map((tip) => tip.text);
const waitingOk = waiting.exists && waiting.progress === 0.35 && waiting.stage === 'Signing you in'
  && waiting.hidden === false && waiting.opacity === 1 && waiting.animating && tipsText.includes(waiting.tip);
const firstTip = waiting.tip;
const tipChanged = await page.waitForFunction((was) => {
  const now = document.getElementById('loading-tip')?.textContent;
  return Boolean(now) && now !== was;
}, firstTip, { timeout: 9000 }).then(() => true).catch(() => false);
console.log('screen shows the stage reached, an animated bud and a tip (should be true):', waitingOk);
console.log('tip changes on its own (should be true):', tipChanged);

// 2. Signed in: the world loads and the screen lifts with the bar full.
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
const lifted = await page.waitForFunction(() => document.getElementById('loading-screen')?.classList.contains('loading-screen-hidden') === true, null, { timeout: 20000 })
  .then(() => true).catch(() => false);
const after = await read();
console.log('lifted once the world is up, bar full (should be true):', lifted, after.progress);

// 3. The world cannot be fetched: the screen says so and offers Try again.
await page.route(`${BASE_URL}/api/world*`, (route) => route.abort());
await page.reload({ waitUntil: 'domcontentloaded' });
const failedShown = await page.waitForFunction(() => document.getElementById('loading-screen')?.classList.contains('loading-screen-failed') === true, null, { timeout: 25000 })
  .then(() => true).catch(() => false);
const failure = await page.evaluate(() => {
  const text = document.getElementById('loading-problem-text');
  const retry = document.getElementById('loading-retry');
  const screen = document.getElementById('loading-screen');
  return {
    sentence: text?.textContent ?? '',
    selectable: text ? getComputedStyle(text).userSelect : '',
    retryVisible: Boolean(retry && retry.offsetParent !== null),
    stillUp: !screen.classList.contains('loading-screen-hidden') && getComputedStyle(screen).opacity === '1',
    ariaHidden: screen.getAttribute('aria-hidden'),
  };
});
console.log('failed screen:', failure);
const failureOk = failedShown && /try again/i.test(failure.sentence) && failure.selectable === 'text'
  && failure.retryVisible && failure.stillUp && failure.ariaHidden === null;

await page.unroute(`${BASE_URL}/api/world*`);
await page.click('#loading-retry');
const recovered = await page.waitForFunction(() => document.getElementById('loading-screen')?.classList.contains('loading-screen-hidden') === true, null, { timeout: 25000 })
  .then(() => true).catch(() => false);
console.log('failed screen says so, stays up, and Try again recovers (should be true):', failureOk, recovered);

const pass = waitingOk && tipChanged && lifted && after.progress === 1 && failureOk && recovered;
await finish(browser, { pass, label: 'opening-screen-stages', errors: errors.filter((m) => !/Failed to load resource|ERR_FAILED|world/i.test(m)) });
