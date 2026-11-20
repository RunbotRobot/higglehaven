// #3556: who is speaking in nearby chat. Nearby chat is anonymous on purpose (docs/API.md "Assistant
// presence"), so a line that arrives while the Chat leaf is open puts a soft mark over the avatar of
// whoever said it, never a name: the mark thins in, stays a moment, thins away. The backlog a poll
// brings in on opening raises no mark, someone nobody spoke for gets none, and a muted sender's line
// (never drawn) raises none either.
//
// Same trustTier client-side patch as nearby-chat-mute-and-report.test.mjs (no Didit key here), and the
// same injected fake avatar as shop-other-avatar-animation.test.mjs. Read back through
// window.__shopOtherAvatars[].hasSpeechCue.
import { launchPage, chooseIdentity, finish, budClick } from './helpers.mjs';

const LABEL = 'Nearby Chat Speech Cue Tester';
const LANDLET_ID = 'nearby-chat-speech-cue-landlet';
const SPEAKER = 'speaker-1';
const QUIET = 'quiet-1';
const { browser, page, errors } = await launchPage();

async function patchTrustTierToIdVerified(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}
await page.route('**/api/auth/me', patchTrustTierToIdVerified);
await page.route('**/api/auth/signup', patchTrustTierToIdVerified);

// The two other avatars are told to the client directly (status 200 stated here, not inherited from a
// real response): this test's account is only client-side id_verified, so a real GET /api/presence would
// refuse it. Everything the client then does with them is the real code.
await page.route('**/api/presence*', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      avatars: [
        { builderId: SPEAKER, x: 3, y: 4, z: 0, heading: 0, equippedAvatar: null, equippedAnimation: null },
        { builderId: QUIET, x: -3, y: 4, z: 0, heading: 0, equippedAvatar: null, equippedAnimation: null },
      ],
    }),
  });
});

// The first poll after opening is the backlog (one old line from the speaker). Later polls return
// whatever the test queues next.
let pollCount = 0;
let queued = [];
await page.route('**/api/nearby-chat?*', async (route) => {
  pollCount += 1;
  const messages = pollCount === 1
    ? [{ messageId: 'old-line', builderId: SPEAKER, text: 'said before you opened this', createdAt: new Date().toISOString() }]
    : queued.splice(0);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages, nextCursor: `cursor-${pollCount}`, landletId: 'landlet-1' }) });
});

// Other avatars are only polled while the shopper stands on a lándlet (pollNearbyPresenceIfNeeded), so,
// like shop-other-avatar-animation.test.mjs, claim one, reload into Shop and take off.
async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(p, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [path, options]);
}
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const builder = (await fetchJson('/api/builders/me')).body.builder;
const landletCreated = await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Speech Cue Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builder.builderId }),
});
console.log('landlet created (status should be 201):', landletCreated.status);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(5000);

// null = that avatar is not in the world at all; false = it is, and wears no mark. The checks below
// compare with === so an absent avatar can neither pass nor fail a "no mark" check by accident.
const cueOf = (id) => page.evaluate((builderId) => {
  const avatar = (window.__shopOtherAvatars ?? []).find((a) => a.builderId === builderId);
  return avatar ? Boolean(avatar.hasSpeechCue) : null;
}, id);
const waitCue = (id, want, timeout = 8000) => page.waitForFunction(
  ([builderId, wanted]) => (window.__shopOtherAvatars ?? []).find((a) => a.builderId === builderId)?.hasSpeechCue === wanted,
  [id, want],
  { timeout },
).then(() => true).catch(() => false);

const bothHere = await page.waitForFunction(
  ([a, b]) => { const ids = (window.__shopOtherAvatars ?? []).map((x) => x.builderId); return ids.includes(a) && ids.includes(b); },
  [SPEAKER, QUIET],
  { timeout: 20000 },
).then(() => true).catch(() => false);
console.log('both other avatars are in the world (should be true):', bothHere);

await budClick(page, '#bud-petal-shop-chat');
await page.waitForSelector('#shop-nearby-chat-panel.open', { timeout: 5000 });
await page.waitForSelector(`.shop-nearby-chat-message[data-builder-id="${SPEAKER}"]`, { timeout: 10000 });

// 1. The backlog raises no mark.
await page.waitForTimeout(600);
const backlogNoCue = (await cueOf(SPEAKER)) === false;
console.log('the line that was there on opening raises no mark (should be true):', backlogNoCue);

// 2. A new line from the speaker marks the speaker, and only the speaker.
queued.push({ messageId: 'live-1', builderId: SPEAKER, text: 'hello, anyone near?', createdAt: new Date().toISOString() });
const speakerMarked = await waitCue(SPEAKER, true);
const quietUnmarked = (await cueOf(QUIET)) === false;
console.log('the avatar that just spoke wears the mark; the one that did not does not (should be true, true):', speakerMarked, quietUnmarked);

// 3. The line carries no name: no speaker label is drawn on an ordinary sender's line.
const noNameOnLine = (await page.locator('.shop-nearby-chat-message-speaker').count()) === 0;
console.log('nothing names the sender on the line (should be true):', noNameOnLine);

// 4. The mark thins away by itself.
const markGoes = await waitCue(SPEAKER, false, 9000);
console.log('the mark thins away on its own (should be true):', markGoes);

// 5. A muted sender's later line raises no mark (the line itself is never drawn).
// The speaker has two lines in the log by now; either one reveals the actions, so take the first.
const speakerLine = page.locator(`.shop-nearby-chat-message[data-builder-id="${SPEAKER}"]`).first();
await speakerLine.locator('.shop-nearby-chat-message-text').click();
await speakerLine.locator('button[data-action="mute"]').click();
queued.push({ messageId: 'live-2', builderId: SPEAKER, text: 'a line after being muted', createdAt: new Date().toISOString() });
await page.waitForTimeout(4500); // two or more polls, and longer than the mark takes to thin in
const mutedNoCue = (await cueOf(SPEAKER)) === false;
console.log('a muted sender raises no mark (should be true):', mutedNoCue);

const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));
const pass = landletCreated.status === 201 && bothHere && backlogNoCue && speakerMarked && quietUnmarked && noNameOnLine && markGoes && mutedNoCue && unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Nearby chat marks the avatar that just spoke, anonymously and only for live lines (#3556)', errors });
