// #2818 (sub-issue of #2780, itself sub-issue of #2777): the client-side
// WebRTC core (src/shop/voiceChat.js) — mic toggle, RTCPeerConnection
// setup against two nearby avatars, and flying-avatar exclusion.
//
// Like e2e/dm-badge.test.mjs/e2e/direct-messages-gating.test.mjs/
// e2e/nearby-chat-send-failure.test.mjs already document: this deployment
// never configures DIDIT_API_KEY, so there's no way to drive a real
// account to trust_tier === 'id_verified' — GET/POST /api/voice/signal and
// GET /api/voice/ice-config (all requireIdVerifiedSessionBuilder-gated)
// would always 403 for a real e2e account. Same workaround those files
// already use: patch /api/auth/me's own trustTier client-side so
// voiceChat.js's hasIdVerifiedSession() check passes, then mock the three
// voice-specific endpoints themselves — but unlike those files (which only
// need the UI to *render* correctly), this test's whole point is the real
// RTCPeerConnection negotiation between two genuine browser pages, so the
// mock below is a real Node-side relay (two in-memory mailboxes, keyed by
// each page's own REAL builderId from GET /api/builders/me, which doesn't
// require id_verified) rather than a canned response — everything except
// the authenticated HTTP transport layer is real: real avatar_presence
// rows (POST /api/presence doesn't require id_verified either, only
// non-'none'), real shopOtherAvatars population, real browser WebRTC
// stack, real perfect-negotiation glare handling in voiceChat.js itself.
//
// Two pages standing in for two different builders, same multi-session
// shape e2e/multiplayer-presence.test.mjs already uses — but unlike that
// file (which only needs each avatar's *reported* position to match
// wherever its own random spawn-orbit happened to land it),
// window.__testTeleportShopAvatar places both at known, close-together
// coordinates directly, since this test needs them genuinely within voice
// range of each other.
import { chromium } from 'playwright';
import { chooseIdentity, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const LABEL_A = 'Voice Suite Builder A';
const LABEL_B = 'Voice Suite Builder B';
const LANDLET_ID = 'voice-suite-landlet';

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Patches trustTier to 'id_verified' on every later GET /api/auth/me — see
// this file's own header comment on why. Deliberately NOT installed until
// after chooseIdentity's own real signup+verify flow (clearVerifyModalIfShown)
// has already completed for real: that flow itself reads the live
// currentAuthUser.trustTier to decide whether to show the verify-modal at
// all, so patching it to 'id_verified' too early would make the app think
// verification is already done and skip the real age-attest/card-setup-
// intent calls entirely -- leaving the REAL account's trust_tier at 'none'
// server-side (still high enough to fail POST /api/presence/POST
// /api/landlets, which only need non-'none', not id_verified). Installed
// only once the real flow has already pushed the account to 'credit_card'
// for real; a page.reload() right after re-fetches /auth/me and is what
// actually lands the patched 'id_verified' value into currentAuthUser.
async function patchTrustTierToIdVerified(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}

// The Node-side relay standing in for worker/lib/social.js's
// handleVoiceSignal — real message passing between the two pages' own
// POST/GET /api/voice/signal calls, just not going through the real
// (id_verified-gated) backend. `mailboxes` is keyed by recipient builderId.
function installVoiceRelay(page, { myBuilderId, mailboxes }) {
  let messageCounter = 0;
  return page.route('**/api/voice/signal*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = JSON.parse(request.postData() || '{}');
      const message = {
        messageId: `voice-signal-relay-${++messageCounter}`,
        fromBuilderId: myBuilderId,
        kind: input.kind,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      };
      mailboxes[input.toBuilderId] ??= [];
      mailboxes[input.toBuilderId].push(message);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ message }) });
      return;
    }
    // GET -- drain this page's own inbox.
    const inbox = mailboxes[myBuilderId] ?? [];
    mailboxes[myBuilderId] = [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: inbox, nextCursor: `cursor-${Date.now()}`, landletId: LANDLET_ID }),
    });
  });
}

async function launchVoicePage(label) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH || undefined,
    // Deterministic synthetic mic, auto-granted -- no real hardware or
    // dialog needed in CI, same shape every other "needs getUserMedia"
    // WebRTC test suite relies on.
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width: 420, height: 860 }, permissions: ['microphone'] });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept(label);
    else await dialog.accept();
  });
  // ICE: host candidates alone are enough for two pages on the same
  // machine -- no real STUN/TURN network dependency needed in this suite.
  await page.route('**/api/voice/ice-config', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ iceServers: [] }),
  }));
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  return { browser, page, errors };
}

const mailboxes = {};
const sessionA = await launchVoicePage(LABEL_A);
const sessionB = await launchVoicePage(LABEL_B);
const pageA = sessionA.page;
const pageB = sessionB.page;

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
await pageA.route('**/api/auth/me', patchTrustTierToIdVerified);
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;
await installVoiceRelay(pageA, { myBuilderId: builderA.builderId, mailboxes });

const landletCreated = await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID, name: 'Voice Suite Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created (status should be 201):', landletCreated.status);

// #1175's own random spawn-orbit means each avatar's real position starts
// out wherever that landed, not necessarily anywhere near the other one --
// unlike multiplayer-presence.test.mjs (which only checks each avatar's
// *reported* position matches, wherever that is), this test needs both
// genuinely close together for a voice connection to even want to form.
// window.__testTeleportShopAvatar (src/shop/flightMovement.js) mutates the
// real shopAvatarPosition directly (also forcing shopFlightState to
// 'grounded') -- the real report loop (reportOwnPresenceIfNeeded) then
// reports this teleported position on its own very next tick, same as it
// would any real walk, so there's no need to also fight it with a direct
// POST /api/presence that the next real tick would just overwrite anyway.
await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.evaluate(() => window.__testTeleportShopAvatar(0, 0, 0));

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
await pageB.route('**/api/auth/me', patchTrustTierToIdVerified);
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;
await installVoiceRelay(pageB, { myBuilderId: builderB.builderId, mailboxes });

await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Comfortably inside VOICE_RANGE_M (30.48m) of A's (0,0,0) above.
await pageB.evaluate(() => window.__testTeleportShopAvatar(1, 0, 0));

// Past SHOP_PRESENCE_REPORT_INTERVAL_MS (1500) x a cushion, so both
// sides' real report loops have actually sent the teleported position.
await pageA.waitForTimeout(2200);
await pageB.waitForTimeout(2200);

// Both sides' voice button should be visible (id_verified, mocked) and
// default to muted -- #2778's resolution: no auto-activate-on-proximity.
await pageA.waitForSelector('#shop-voice-btn.visible', { timeout: 10000 });
await pageB.waitForSelector('#shop-voice-btn.visible', { timeout: 10000 });
const aMutedByDefault = await pageA.evaluate(() => document.getElementById('shop-voice-btn').classList.contains('muted'));
const bMutedByDefault = await pageB.evaluate(() => document.getElementById('shop-voice-btn').classList.contains('muted'));

// Give both sides' poll loops (VOICE_POLL_INTERVAL_MS = 1200) and the
// real WebRTC stack several cycles to actually negotiate a connection.
async function waitForConnected(page, expectedBuilderId, timeoutMs = 20000) {
  const start = Date.now();
  let peers = null;
  while (Date.now() - start < timeoutMs) {
    peers = await page.evaluate(() => window.__shopVoicePeers);
    const entry = peers?.find((p) => p.builderId === expectedBuilderId);
    if (entry?.connectionState === 'connected') return entry;
    await page.waitForTimeout(300);
  }
  console.log('waitForConnected timed out, last seen peers:', peers);
  return null;
}

// Let the BASE (recvonly<->recvonly, no mic yet) connection reach
// 'connected' before unmuting either side. Both unmuting at once while the
// base negotiation is still mid-flight triggers an *overlapping* second
// renegotiation round on top of the first -- WebRTC's perfect-negotiation
// pattern handles this correctly (confirmed: it does eventually converge),
// but it can take a variable, occasionally test-timeout-exceeding number of
// extra offer/answer round trips to settle, found as real flakiness while
// validating this test. A real user is never going to click unmute in the
// exact same instant their peer connection object was first created, so
// settling the base connection first is also just a more realistic
// sequence, not merely a convenience for this test.
await waitForConnected(pageA, builderB.builderId);
await waitForConnected(pageB, builderA.builderId);

// Unmute both -- exercises the real getUserMedia prompt (fake device,
// auto-granted) and the recvonly-to-sendrecv transceiver upgrade.
await pageA.click('#shop-voice-btn');
await pageB.click('#shop-voice-btn');
await pageA.waitForSelector('#shop-voice-btn.unmuted', { timeout: 10000 });
await pageB.waitForSelector('#shop-voice-btn.unmuted', { timeout: 10000 });

const aSeesB = await waitForConnected(pageA, builderB.builderId);
const bSeesA = await waitForConnected(pageB, builderA.builderId);
console.log('A\'s own view of its connection to B:', aSeesB);
console.log('B\'s own view of its connection to A:', bSeesA);

// Flying-avatar exclusion (#2043, reused here with no extra code of its
// own): GET /api/presence withholds a flying builder's row entirely, so B
// taking off should make B disappear from A's own shopOtherAvatars on A's
// very next poll, and voiceChat.js's updateVoicePeersForRange should tear
// that connection down the same way it tears down any other avatar that's
// no longer nearby.
await pageB.click('#shop-fly-btn'); // takes off this time -- was grounded since the landing above
await pageA.waitForTimeout(3000); // past SHOP_PRESENCE_POLL_INTERVAL_MS (1000) x a few cycles

async function waitForTeardown(page, builderId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const peers = await page.evaluate(() => window.__shopVoicePeers);
    if (!peers?.some((p) => p.builderId === builderId)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}
const bTornDownInA = await waitForTeardown(pageA, builderB.builderId);
console.log('A\'s connection to B torn down once B started flying (should be true):', bTornDownInA);

const errors = [...sessionA.errors, ...sessionB.errors];
const pass =
  landletCreated.status === 201 &&
  aMutedByDefault && bMutedByDefault &&
  !!aSeesB && !!bSeesA &&
  bTornDownInA &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: 'Voice chat client core (#2818): muted by default, real RTCPeerConnection negotiation between two nearby avatars, flying-avatar exclusion tears the connection down',
  errors,
});
