// #3248: the microphone button used to be drawn from first paint, before the
// rest of the Shop HUD, because its bare `#shop-voice-btn { display: flex }`
// id rule outranked the `.shop-ui { display: none }` class gate. The owner
// wants the HUD to appear as one group once the world is ready.
//
// A MutationObserver installed before any app code runs records, for every
// moment #shop-voice-btn becomes visible, whether #shop-fly-btn (revealed by
// src/shop/mode.js together with Feedback and the vertical controls) was
// already visible. It also checks the button is genuinely hidden (computed
// display: none) until the HUD is revealed.
//
// This deployment never configures DIDIT_API_KEY, so no real account can reach
// trust_tier 'id_verified' (see e2e/voice-chat-core.test.mjs's header); same
// workaround: patch /api/auth/me's trustTier client-side, after the real
// signup flow, then reload.
import { chromium } from 'playwright';
import { chooseIdentity, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const LABEL = 'Shop HUD Voice Reveal Builder';

const browser = await chromium.launch({ executablePath: CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept(LABEL);
  else await dialog.accept();
});
// Keep the voice polls (gated on id_verified, which is only mocked
// client-side) from ever reaching the real backend.
await page.route('**/api/voice/signal*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ messages: [], nextCursor: 'c', landletId: null }),
}));
await page.route('**/api/voice/friend-channels*', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ channels: [] }),
}));
await page.route('**/api/voice/ice-config', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ iceServers: [] }),
}));

// Recorded in the page, before any app script runs.
await page.addInitScript(() => {
  window.__hudOrder = { voiceShownBeforeFly: false, voiceEverShown: false };
  const isShown = (el) => el && getComputedStyle(el).display !== 'none';
  const check = () => {
    const voice = document.getElementById('shop-voice-btn');
    const fly = document.getElementById('shop-fly-btn');
    if (!voice) return;
    if (isShown(voice)) {
      window.__hudOrder.voiceEverShown = true;
      if (!isShown(fly)) window.__hudOrder.voiceShownBeforeFly = true;
    }
  };
  const start = () => {
    check();
    new MutationObserver(check).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'],
    });
    // Also poll every frame: a purely CSS-driven first paint (the original
    // bug) involves no attribute mutation at all.
    const tick = () => { check(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
});

await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.route('**/api/auth/me', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
});
await page.reload({ waitUntil: 'domcontentloaded' });

await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });
await page.waitForSelector('#shop-voice-btn.visible', { timeout: 10000 });
await page.waitForTimeout(500);

const order = await page.evaluate(() => window.__hudOrder);
const voiceDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('shop-voice-btn')).display);
console.log('voice button ever shown (should be true):', order.voiceEverShown);
console.log('voice button shown before the fly button (should be false):', order.voiceShownBeforeFly);
console.log('voice button display once the HUD is up (should be flex):', voiceDisplay);

const pass = order.voiceEverShown && !order.voiceShownBeforeFly && voiceDisplay === 'flex' && errors.length === 0;
await finish(browser, {
  pass,
  label: 'Shop HUD (#3248): the microphone button appears with the rest of the HUD, never ahead of it',
  errors,
});
