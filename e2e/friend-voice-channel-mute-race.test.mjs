// #2905: regression coverage for a mute-race in a friend voice channel's
// gain handling. src/shop/voiceChat.js's attachRemoteStream used to
// hardcode a friend-channel peer's gain to full volume (1) every time it
// ran -- and it reruns on every real pc.ontrack event, not just the first.
// A friend who joins a channel muted-by-default (#2778: no
// auto-activate-on-proximity) only sends their first real audio track once
// they personally grant their own mic, which can happen well after the
// local user has already muted that peer's row in the panel (the row, and
// its mute button, exist the moment the connection reaches 'connected' --
// long before any track or GainNode exists). That first real ontrack used
// to silently override the already-recorded mute back to full volume,
// self-correcting only once the next reconcileFriendVoiceChannels poll tick
// (up to FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS later) re-synced it.
//
// Mirrors e2e/friend-voice-channel.test.mjs's own setup almost exactly (two
// real browser pages, a real accepted friendship, a real "Join Voice"
// click, the same Node-side signal-relay/friend-channels mocks) -- see that
// file's own header comment for why each piece of the setup below is
// needed. Trimmed to just what this specific race needs: no "teleport far
// apart and confirm the connection survives" section, since this bug has
// nothing to do with distance.
import { chromium } from 'playwright';
import { chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const LABEL_A = 'Friend Voice Mute Race Owner';
const LABEL_B = 'Friend Voice Mute Race Joiner';

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

// Same no-reload trustTier bump e2e/friend-voice-channel.test.mjs's own
// header comment explains in full.
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

// Same Node-side relay e2e/friend-voice-channel.test.mjs's own
// installVoiceSignalRelay uses.
function installVoiceSignalRelay(page, { myBuilderId, mailboxes }) {
  let messageCounter = 0;
  return page.route('**/api/voice/signal*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = JSON.parse(request.postData() || '{}');
      const message = {
        messageId: `friend-voice-mute-race-relay-${++messageCounter}`,
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
    const inbox = mailboxes[myBuilderId] ?? [];
    mailboxes[myBuilderId] = [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: inbox, nextCursor: `cursor-${Date.now()}`, landletId: null }),
    });
  });
}

// Same Node-side stand-in for GET/POST .../friend-channels as
// e2e/friend-voice-channel.test.mjs's own installFriendChannelsMock.
function installFriendChannelsMock(page, { myBuilderId, channels }) {
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
          channels.splice(channels.indexOf(channel), 1);
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

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
await claimLandlet(pageA);
await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
await claimLandlet(pageB);

const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;

await installVoiceSignalRelay(pageA, { myBuilderId: builderA.builderId, mailboxes });
await installVoiceSignalRelay(pageB, { myBuilderId: builderB.builderId, mailboxes });
await installFriendChannelsMock(pageA, { myBuilderId: builderA.builderId, channels: friendChannels });
await installFriendChannelsMock(pageB, { myBuilderId: builderB.builderId, channels: friendChannels });
const unreadCountMock = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) });
await pageA.route('**/api/direct-messages/unread-count', unreadCountMock);
await pageB.route('**/api/direct-messages/unread-count', unreadCountMock);

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

await bumpToIdVerifiedNoReload(pageA);
await bumpToIdVerifiedNoReload(pageB);

// B joins A's voice channel -- same real click as #2834's own test.
await openAccountMenu(pageB);
await pageB.click('#friends-btn');
await pageB.waitForSelector('#friends-modal.visible', { timeout: 5000 });
const joinVoiceBtn = pageB.locator('#friends-accepted-list .friend-row').filter({ hasText: LABEL_A }).locator('button', { hasText: 'Join Voice' });
await joinVoiceBtn.waitFor({ state: 'visible', timeout: 10000 });
await joinVoiceBtn.click();
await pageB.waitForFunction(
  () => [...document.querySelectorAll('#friends-accepted-list .friend-row')]
    .some((row) => row.textContent.includes('Friend Voice Mute Race Owner') && row.textContent.includes('Leave Voice')),
  null,
  { timeout: 10000 },
);
await pageB.click('#friends-close-btn');

async function enterShopGrounded(page) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
  await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
  await page.click('#shop-fly-btn');
  await page.waitForTimeout(2500);
}
await enterShopGrounded(pageA);
await enterShopGrounded(pageB);
// Far apart, same as #2834's own test -- this bug has nothing to do with
// distance, and keeping them apart rules out any ordinary proximity
// connection muddying which code path actually set the gain.
await pageA.evaluate(() => window.__testTeleportShopAvatar(0, 0, 0));
await pageB.evaluate(() => window.__testTeleportShopAvatar(10000, 0, 0));
await pageA.waitForTimeout(2200);
await pageB.waitForTimeout(2200);

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
console.log('A connected to B via the friend channel, before either side has unmuted a real mic (should be connected):', aSeesB);

// The mute/report panel renders a row for any *connected* peer regardless
// of whether a real audio track/GainNode exists yet (renderVoicePeersList
// filters purely on pc.connectionState) -- this is the actual real-world
// window the bug lives in: muting here, before B ever grants their own
// mic, is something a real user can do (and would want to do, for a
// friend who joins muted-by-default per #2778).
await pageA.waitForSelector('#shop-voice-peers-panel.open', { timeout: 10000 });
await pageA.click('#shop-voice-peers-list button[data-action="mute"]');
await pageA.waitForSelector('#shop-voice-peers-list button.shop-voice-peer-muted', { timeout: 5000 });
const aMutedBBeforeTrack = await pageA.evaluate((builderId) => {
  const entry = window.__shopVoicePeers?.find((p) => p.builderId === builderId);
  return entry?.muted === true && entry?.gainValue === null; // no GainNode yet -- nothing to apply the mute to until a track arrives
}, builderB.builderId);
console.log('A muted B while B still has no real track/GainNode yet (should be true):', aMutedBBeforeTrack);

// Now B grants their own mic for the first time -- this is what actually
// fires A's pc.ontrack for the first time (A never unmutes at all, so the
// only renegotiation in this test is the one B's own mic grant triggers),
// running attachRemoteStream on A's side for its connection to B.
await pageB.click('#shop-voice-btn');
await pageB.waitForSelector('#shop-voice-btn.unmuted', { timeout: 10000 });

// Capture the gain value the instant attachRemoteStream (A's side) first
// sets it -- polled frequently (100ms), comfortably faster than the
// ~1.2s FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS reconcileFriendVoiceChannels
// tick that would otherwise correct a wrong value back, so this is really
// observing attachRemoteStream's own initial assignment, not a later
// correction.
let firstGainForB = null;
{
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const peers = await pageA.evaluate(() => window.__shopVoicePeers);
    const entry = peers?.find((p) => p.builderId === builderB.builderId);
    if (entry?.gainValue !== null && entry?.gainValue !== undefined) { firstGainForB = entry.gainValue; break; }
    await pageA.waitForTimeout(100);
  }
  if (firstGainForB === null) {
    console.log('timed out waiting for a gain value -- A\'s last-seen peers:', await pageA.evaluate(() => window.__shopVoicePeers));
    console.log('B\'s last-seen peers:', await pageB.evaluate(() => window.__shopVoicePeers));
  }
}
console.log('A\'s gain for B the instant a real track first attaches, despite A having already muted B (should be 0, not 1):', firstGainForB);

const errors = [...sessionA.errors, ...sessionB.errors];
const pass =
  !!aSeesB &&
  aMutedBBeforeTrack &&
  firstGainForB === 0 &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: '#2905: muting a friend-channel peer before their first real track arrives stays muted once attachRemoteStream runs, instead of being silently reset to full volume',
  errors,
});
