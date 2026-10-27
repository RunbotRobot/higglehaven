// #2834 (sub-issue of #2781, itself sub-issue of #2777): end-to-end
// coverage for friend group voice channels' real client-side behavior.
// worker/friend-voice-channels.test.js already covers the backend contract
// (join/leave authorization, membership semantics) thoroughly; this is
// what's left -- mirroring e2e/voice-chat-core.test.mjs's own approach (two
// real browser pages, a real RTCPeerConnection) but for the friend-channel
// path specifically: full volume with no distance-based ramp, and a
// connection that survives -- rather than gets torn down the way an
// ordinary proximity peer would -- once the two avatars are nowhere near
// each other. That "survives being far apart" is also this test's coverage
// for reconcileFriendVoiceChannels's own interval running independently of
// the Shop-mode render tick: updateVoicePeersForRange (the render-tick-
// driven, distance-gated function) explicitly skips any peer tagged with a
// channelOwnerBuilderId (src/shop/voiceChat.js's own comment on this), so a
// friend-channel connection staying up while both avatars are far enough
// apart that an ordinary proximity connection could never even form in the
// first place can only be reconcileFriendVoiceChannels's own setInterval at
// work -- there's no other code path that could have created or kept it.
//
// Unlike #2818's own voice-chat-core.test.mjs (pure proximity, no
// friendship needed), this test needs a REAL accepted friendship between
// the two builders -- the actual "Join Voice" UI (src/account/menu.js) only
// renders a row for an accepted friend in the first place -- done via the
// same real "+ Add Friend"/Accept Friends-panel flow e2e/friends.test.mjs
// and e2e/direct-messages-gating.test.mjs already use. And since the
// Friends panel (where that button lives) is Build/Sell-mode-only
// (src/main.js's SHOP_HIDDEN_BUILDER_UI_IDS explicitly hides #friends-btn
// while in Shop mode), joining has to happen before either page ever
// switches to Shop mode for the WebRTC/mic part below.
//
// This deployment never configures DIDIT_API_KEY (see this repo's other
// voice/DM/nearby-chat e2e tests for the same note), so there's no way to
// drive an account to a REAL server-side trust_tier of 'id_verified'.
// Unlike those other tests, this one still needs claimLandlet (a real
// landlet to stand on in Shop mode) and the real add-friend/accept flow to
// work first, both of which only need the real 'credit_card' floor
// chooseIdentity's own clearVerifyModalIfShown call already reaches for
// real -- patching trustTier any earlier (voice-chat-core.test.mjs's own
// header comment explains this in detail) would make the app think
// verification is already done and skip that real flow entirely, leaving
// the REAL account stuck at 'none', too low even for claimLandlet. So the
// trustTier patch here is applied only afterward, and -- since the Friends
// panel's own Join Voice button needs it applied without ever leaving
// Build mode via a reload -- via the same no-reload path
// refreshAccountAuthUI (src/account/auth.js) already uses for a real
// Didit-approval reconciliation: clicking #account-auth-btn while already
// logged in calls it, which (trustTier not yet id_verified) checks GET
// /api/auth/didit-verification-status and, on an 'approved' status, calls
// refreshCurrentUser() -- a live GET /api/auth/me refetch with no reload.
// Mocking that status endpoint to 'approved' alongside the existing
// /api/auth/me patch triggers that exact real reconciliation path.
//
// GET/POST /api/voice/friend-channels is exactly as id_verified-gated
// server-side (worker/lib/social.js's handleFriendVoiceChannels, same
// requireIdVerifiedSessionBuilder as the signal relay), so -- like
// GET/POST /api/voice/signal and GET /api/voice/ice-config -- it needs a
// Node-side in-memory mock below rather than a real call.
import { chromium } from 'playwright';
import { chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const LABEL_A = 'Friend Voice Suite Owner';
const LABEL_B = 'Friend Voice Suite Joiner';

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

async function patchTrustTierToIdVerified(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}

// Bumps this page's own currentAuthUser.trustTier to 'id_verified'
// client-side with no reload -- see this file's own header comment for the
// full reasoning. Only installs the two mocks and drives the real
// no-reload refresh path; doesn't touch Build-mode UI state otherwise.
async function bumpToIdVerifiedNoReload(page) {
  await page.route('**/api/auth/me', patchTrustTierToIdVerified);
  await page.route('**/api/auth/didit-verification-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'approved' }),
  }));
  await openAccountMenu(page);
  await page.click('#account-auth-btn');
  await page.waitForFunction(
    () => document.getElementById('auth-account-trust-tier')?.textContent.includes('ID-verified'),
    null,
    { timeout: 10000 },
  );
  await page.click('#auth-close-btn');
}

// Same Node-side relay voice-chat-core.test.mjs's own installVoiceRelay
// uses for POST/GET /api/voice/signal -- carries channelOwnerBuilderId
// through too (worker/lib/social.js's voiceSignalMessageFromRow does this
// for real), since voiceChat.js's handleIncomingSignal needs it to tag a
// peer it's hearing about reactively (an incoming offer) rather than
// proactively (this module's own reconcileFriendVoiceChannels poll).
function installVoiceSignalRelay(page, { myBuilderId, mailboxes }) {
  let messageCounter = 0;
  return page.route('**/api/voice/signal*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = JSON.parse(request.postData() || '{}');
      const message = {
        messageId: `friend-voice-signal-relay-${++messageCounter}`,
        fromBuilderId: myBuilderId,
        kind: input.kind,
        payload: input.payload,
        channelOwnerBuilderId: input.channelOwnerBuilderId || null,
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
      body: JSON.stringify({ messages: inbox, nextCursor: `cursor-${Date.now()}`, landletId: null }),
    });
  });
}

// Node-side stand-in for worker/lib/social.js's handleFriendVoiceChannels
// -- see this file's own header comment on why this can't go through the
// real (id_verified-gated) backend. `channels` (shared across both pages'
// own routes, same closure-sharing shape `mailboxes` above uses) is an
// array of { ownerBuilderId, members: Set<builderId> }, mirroring the real
// table's own one-row-per-member shape closely enough for this test's
// purposes -- own membership row marks a channel "active," owner leaving
// closes it for everyone, a member leaving only removes themselves, same
// semantics the real handler documents.
function installFriendChannelsMock(page, { myBuilderId, channels }) {
  // Two separate registrations, not one `**/api/voice/friend-channels*` --
  // same gotcha e2e/dm-load-more.test.mjs's own comment documents: a
  // trailing `*` (Playwright glob, unlike `**`) never matches across a
  // `/`, so a single `*`-suffixed pattern would catch the bare GET but
  // silently let POST .../:ownerBuilderId/join|leave fall through
  // unmocked to the real (id_verified-gated) backend -- confirmed as the
  // real cause of an earlier version of this test failing with "ID
  // verification is required..." on the join click.
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const mine = channels
        .filter((c) => c.members.has(myBuilderId))
        .map((c) => ({ ownerBuilderId: c.ownerBuilderId, members: [...c.members] }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ channels: mine }) });
      return;
    }
    // POST .../:ownerBuilderId/join or .../:ownerBuilderId/leave.
    const segments = url.pathname.split('/').filter(Boolean);
    const ownerBuilderId = decodeURIComponent(segments[3] || '');
    const action = segments[4];
    let channel = channels.find((c) => c.ownerBuilderId === ownerBuilderId);
    if (action === 'join') {
      if (!channel) {
        channel = { ownerBuilderId, members: new Set([ownerBuilderId]) };
        channels.push(channel);
      }
      channel.members.add(myBuilderId);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (action === 'leave') {
      if (channel) {
        if (myBuilderId === ownerBuilderId) {
          channels.splice(channels.indexOf(channel), 1); // owner leaving closes it for everyone
        } else {
          channel.members.delete(myBuilderId);
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected friend-channels route in test mock' }) });
  };
  return Promise.all([
    page.route('**/api/voice/friend-channels', handler),
    page.route('**/api/voice/friend-channels/**', handler),
  ]);
}

async function launchVoicePage(label) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH || undefined,
    // Deterministic synthetic mic, auto-granted -- no real hardware or
    // dialog needed in CI, same shape voice-chat-core.test.mjs already uses.
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
const friendChannels = [];
const sessionA = await launchVoicePage(LABEL_A);
const sessionB = await launchVoicePage(LABEL_B);
const pageA = sessionA.page;
const pageB = sessionB.page;

// Build mode, real signup through the real credit-card floor, real landlet
// claim -- nothing patched yet (see this file's own header comment on why
// that order matters).
await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
await claimLandlet(pageA);
await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
await claimLandlet(pageB);

const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;

// Installed now, before either page ever becomes id_verified below --
// src/shop/voiceChat.js's own global polling interval starts firing the
// instant hasIdVerifiedSession() reads true, so these have to already be
// in place or that interval's very first tick(s) would hit the real
// (unmocked, id_verified-gated) endpoints directly and 403, independent of
// anything this test does explicitly afterward.
await installVoiceSignalRelay(pageA, { myBuilderId: builderA.builderId, mailboxes });
await installVoiceSignalRelay(pageB, { myBuilderId: builderB.builderId, mailboxes });
await installFriendChannelsMock(pageA, { myBuilderId: builderA.builderId, channels: friendChannels });
await installFriendChannelsMock(pageB, { myBuilderId: builderB.builderId, channels: friendChannels });
// GET /api/direct-messages/unread-count is unrelated to voice but is also
// requireIdVerifiedSessionBuilder-gated (e2e/dm-badge.test.mjs's own
// comment) and fires from a real, already-reachable bootstrap call site
// the instant trustTier flips to id_verified below -- same race as the
// two mocks above, so it needs the same treatment to avoid a stray real
// 403 unrelated to anything this test is actually checking.
const unreadCountMock = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) });
await pageA.route('**/api/direct-messages/unread-count', unreadCountMock);
await pageB.route('**/api/direct-messages/unread-count', unreadCountMock);

// Real "+ Add Friend"/Accept flow (same as e2e/friends.test.mjs/
// e2e/direct-messages-gating.test.mjs) -- credit_card tier is enough for
// this, no patch needed yet.
await openAccountMenu(pageA);
await pageA.click('#friends-btn');
await pageA.waitForSelector('#friends-modal.visible', { timeout: 5000 });
pageA.removeAllListeners('dialog');
pageA.on('dialog', (dialog) => dialog.accept(LABEL_B));
await pageA.click('#friends-add-btn');
await waitForText(pageA, '#friends-status', LABEL_B);
await pageA.click('#friends-close-btn');

await openAccountMenu(pageB);
await pageB.click('#friends-btn');
await pageB.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await pageB.waitForFunction(() => document.querySelectorAll('#friends-incoming-list .friend-row').length > 0, null, { timeout: 30000 });
await pageB.locator('#friends-incoming-list .friend-row').filter({ hasText: LABEL_A }).locator('button', { hasText: 'Accept' }).click();
await pageB.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, null, { timeout: 30000 });
await pageB.click('#friends-close-btn');

// Both need to be id_verified client-side for anything voice-related to
// run at all (src/shop/voiceChat.js's own hasIdVerifiedSession() gate
// covers both the join UI's own render check AND each page's own global
// signaling-poll interval) -- see this file's own header comment for how
// this is done with no reload.
await bumpToIdVerifiedNoReload(pageA);
await bumpToIdVerifiedNoReload(pageB);

// The real "Join Voice" click -- joinFriendVoiceChannel (src/shop/
// voiceChat.js) calls the (mocked) POST .../join then
// reconcileFriendVoiceChannels directly, so the first peer-connection
// attempt starts right here, in Build mode, before Shop mode's own render
// tick has run even once.
await openAccountMenu(pageB);
await pageB.click('#friends-btn');
await pageB.waitForSelector('#friends-modal.visible', { timeout: 5000 });
const joinVoiceBtn = pageB.locator('#friends-accepted-list .friend-row').filter({ hasText: LABEL_A }).locator('button', { hasText: 'Join Voice' });
await joinVoiceBtn.waitFor({ state: 'visible', timeout: 10000 });
await joinVoiceBtn.click();
await pageB.waitForFunction(
  () => [...document.querySelectorAll('#friends-accepted-list .friend-row')]
    .some((row) => row.textContent.includes('Friend Voice Suite Owner') && row.textContent.includes('Leave Voice')),
  null,
  { timeout: 10000 },
);
await pageB.click('#friends-close-btn');

// Now enter Shop mode for each (stopping the spawn orbit, same reasoning
// voice-chat-core.test.mjs's own comment gives) and teleport far apart.
// 10000 units is nowhere close to VOICE_RANGE_M (30.48m) -- an ordinary
// proximity connection could never form at this distance, so anything that
// connects here can only be the already-joined friend-channel path.
async function enterShopGrounded(page) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
  await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
  await page.click('#shop-fly-btn'); // stops the orbit and starts landing
  await page.waitForTimeout(2500); // past landing
}
await enterShopGrounded(pageA);
await enterShopGrounded(pageB);
await pageA.evaluate(() => window.__testTeleportShopAvatar(0, 0, 0));
await pageB.evaluate(() => window.__testTeleportShopAvatar(10000, 0, 0));
// Past SHOP_PRESENCE_REPORT_INTERVAL_MS x a cushion, so both sides' real
// report loops have actually sent the teleported position.
await pageA.waitForTimeout(2200);
await pageB.waitForTimeout(2200);

const otherAvatarsSeenByA = await pageA.evaluate(() => window.__shopOtherAvatars);
console.log('builders A can see nearby while 10000 units apart from B (should NOT include B at all):', otherAvatarsSeenByA);

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

const aSeesB = await waitForConnected(pageA, builderB.builderId);
const bSeesA = await waitForConnected(pageB, builderA.builderId);
console.log('A\'s own view of its connection to B, formed purely via the friend channel (should be connected, channelOwnerBuilderId = A\'s own id):', aSeesB);
console.log('B\'s own view of its connection to A (should be connected, channelOwnerBuilderId = A\'s own id):', bSeesA);

const bothTaggedWithChannelOwner =
  aSeesB?.channelOwnerBuilderId === builderA.builderId &&
  bSeesA?.channelOwnerBuilderId === builderA.builderId;

// Unmute both -- exercises the real getUserMedia prompt (fake device,
// auto-granted) and the recvonly-to-sendrecv transceiver upgrade, which is
// what actually populates each side's own gainNode (attachRemoteStream,
// fired from pc.ontrack once a real remote track arrives).
await pageA.click('#shop-voice-btn');
await pageB.click('#shop-voice-btn');
await pageA.waitForSelector('#shop-voice-btn.unmuted', { timeout: 10000 });
await pageB.waitForSelector('#shop-voice-btn.unmuted', { timeout: 10000 });

async function waitForGain(page, expectedBuilderId, timeoutMs = 20000) {
  const start = Date.now();
  let peers = null;
  while (Date.now() - start < timeoutMs) {
    peers = await page.evaluate(() => window.__shopVoicePeers);
    const entry = peers?.find((p) => p.builderId === expectedBuilderId);
    if (entry?.gainValue !== null && entry?.gainValue !== undefined) return entry;
    await page.waitForTimeout(300);
  }
  console.log('waitForGain timed out, last seen peers:', peers);
  return null;
}

const aGainForB = await waitForGain(pageA, builderB.builderId);
const bGainForA = await waitForGain(pageB, builderA.builderId);
console.log('A\'s gain for its connection to B, despite 10000 units of distance (should be 1, full volume, no ramp):', aGainForB?.gainValue);
console.log('B\'s gain for its connection to A (should be 1):', bGainForA?.gainValue);

// Move B even farther away, well past any VOICE_RANGE_M/VOICE_DISCONNECT_RADIUS_M
// an ordinary proximity peer would tolerate -- the connection should stay
// up regardless, unlike voice-chat-core.test.mjs's own flying-avatar
// teardown test for a proximity peer. Several real Shop-mode render ticks
// (and reconcileFriendVoiceChannels poll cycles) happen in the wait below,
// so this isn't just "never got torn down because nothing ran" -- the
// render tick's own updateVoicePeersForRange genuinely runs and genuinely
// skips this peer each time (see that function's own comment on why).
await pageB.evaluate(() => window.__testTeleportShopAvatar(50000, 0, 0));
await pageA.waitForTimeout(2200);
await pageB.waitForTimeout(2200);
await pageA.waitForTimeout(3000); // several more render ticks/poll cycles

const aStillConnectedToB = await waitForConnected(pageA, builderB.builderId, 5000);
const bStillConnectedToA = await waitForConnected(pageB, builderA.builderId, 5000);
console.log('A still connected to B after moving B even farther away (should still be connected, not torn down):', aStillConnectedToB);
console.log('B still connected to A (should still be connected):', bStillConnectedToA);

const errors = [...sessionA.errors, ...sessionB.errors];
const pass =
  !otherAvatarsSeenByA.some((a) => a.builderId === builderB.builderId) &&
  bothTaggedWithChannelOwner &&
  aGainForB?.gainValue === 1 &&
  bGainForA?.gainValue === 1 &&
  !!aStillConnectedToB &&
  !!bStillConnectedToA &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: '#2834: a friend voice channel connects and stays connected at full volume, with no regard to distance',
  errors,
});
