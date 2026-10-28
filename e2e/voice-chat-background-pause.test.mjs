// #2868: src/shop/voiceChat.js's module-level setInterval (polls GET
// /api/voice/signal and GET /api/voice/friend-channels every
// FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS, unconditionally, for any
// id_verified session) had no Page Visibility handling at all — a
// backgrounded or simply forgotten-open tab kept polling indefinitely,
// which is what actually drove the Control Room D1 database's free-tier
// daily row-read cap to zero (see that issue's own body for the real
// production timeline). This is narrow coverage for the fix itself: the
// poll should stop while `document.hidden` is true and resume once it's
// false again, on the very next tick either way (no separate
// visibilitychange listener to also verify — the fix just re-reads
// document.hidden fresh each tick).
//
// Unlike e2e/voice-chat-core.test.mjs/e2e/friend-voice-channel.test.mjs
// (two real pages, a real RTCPeerConnection), this needs none of that —
// the loop under test polls regardless of Shop mode, proximity, or any
// peer existing at all, so a single page with both endpoints mocked to
// just count hits is enough. Same `patchTrustTierToIdVerified` + reload
// trick those two files already use to reach the id_verified branch
// without a real DIDIT_API_KEY (see voice-chat-core.test.mjs's own header
// comment for the full reasoning).
import { chromium } from 'playwright';
import { chooseIdentity, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const LABEL = 'Voice Background Pause Suite';
// Comfortably above FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS (1200ms) so a
// wait of a few of these is several real poll ticks, not a coin flip.
const POLL_INTERVAL_MS = 1200;

async function patchTrustTierToIdVerified(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept(LABEL);
  else await dialog.accept();
});

await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.route('**/api/auth/me', patchTrustTierToIdVerified);

// Count hits on each endpoint this loop polls -- both id_verified-gated
// server-side, so (same gap voice-chat-core.test.mjs's own header comment
// explains) they'd always 403 for this account's real trust_tier without
// a mock, patched client-side-only above.
let signalHits = 0;
let friendChannelHits = 0;
await page.route('**/api/voice/signal*', async (route) => {
  signalHits += 1;
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ messages: [], nextCursor: `cursor-${Date.now()}`, landletId: null }),
  });
});
await page.route('**/api/voice/friend-channels*', async (route) => {
  friendChannelHits += 1;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ channels: [] }) });
});

// Lands the patched 'id_verified' trustTier into currentAuthUser for real
// (same as voice-chat-core.test.mjs) -- this is also what (re)starts the
// module-level setInterval under test with hasIdVerifiedSession() now
// true on every tick. A plain reload always lands back on Shop mode by
// default (chooseIdentity's own N44 comment) regardless of the 'build'
// mode just chosen above, which matters here: Shop mode's own
// requestAnimationFrame-driven render loop (updateShopMovement ->
// updateShopVoiceChatIfNeeded) ALSO calls pollVoiceSignalsIfNeeded every
// frame, a second, pre-existing call site this fix doesn't touch (per
// this issue's own text, a real backgrounded tab's rAF loop already stops
// on its own at the browser level -- not something a headless
// `document.hidden` override reproduces). Explicitly switching to Build
// mode right after keeps that unrelated render loop from ever starting,
// so every signal/friend-channels hit below can only come from the
// setInterval actually under test.
await page.reload({ waitUntil: 'networkidle' });
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 });

// Baseline: visible (document.hidden defaults to false), the loop should
// be polling normally.
await page.waitForTimeout(POLL_INTERVAL_MS * 3);
const baselineSignalHits = signalHits;
const baselineFriendChannelHits = friendChannelHits;
console.log('Baseline (visible) poll hits -- signal, friend-channels (both should be > 0):', baselineSignalHits, baselineFriendChannelHits);

// Simulate backgrounding: `document.hidden` is a getter on Document's own
// prototype, so defining an own property directly on the instance shadows
// it with no need for the prototype's property to be configurable. No
// visibilitychange event needs dispatching -- the fix under test just
// re-reads document.hidden fresh on each setInterval tick, nothing listens
// for the event itself.
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
});
signalHits = 0;
friendChannelHits = 0;
await page.waitForTimeout(POLL_INTERVAL_MS * 3);
const hiddenSignalHits = signalHits;
const hiddenFriendChannelHits = friendChannelHits;
console.log('While hidden, poll hits over 3 intervals -- signal, friend-channels (both should be 0):', hiddenSignalHits, hiddenFriendChannelHits);

// Simulate foregrounding again -- the very next tick should resume
// polling with no separate recovery step needed.
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
});
signalHits = 0;
friendChannelHits = 0;
await page.waitForTimeout(POLL_INTERVAL_MS * 3);
const resumedSignalHits = signalHits;
const resumedFriendChannelHits = friendChannelHits;
console.log('After becoming visible again, poll hits over 3 intervals -- signal, friend-channels (both should be > 0):', resumedSignalHits, resumedFriendChannelHits);

const pass =
  baselineSignalHits > 0 && baselineFriendChannelHits > 0 &&
  hiddenSignalHits === 0 && hiddenFriendChannelHits === 0 &&
  resumedSignalHits > 0 && resumedFriendChannelHits > 0;

await finish(browser, {
  pass,
  label: 'Voice chat background-tab poll pause (#2868): friend-channel/signal polling stops while document.hidden is true and resumes once visible again',
  errors,
});
