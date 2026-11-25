// #4317 (from the #4277 audit): the head's notices dot and friend-request note are read once at start-up; one failed
// request used to be kept as the answer for the whole visit. Each is now asked again in the background (after 2 s,
// then 8 s). Here every request for either count fails with a 500 during the first 1.8 s after the first one, which
// also fails the other start-up refreshes that would otherwise paper over a missing retry, and the ones after answer;
// the dot and the friends count must then appear without the person doing anything.
// Like dm-badge.test.mjs, the account is patched to read as verified on the client (the real endpoints refuse an
// unverified one), and the voice polls that start with it are answered empty.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Head Counts Retry Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.route('**/api/auth/me', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) { body.user.trustTier = 'id_verified'; body.user.ageAttested = true; }
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
});
await page.route('**/api/voice/signal*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], nextCursor: null, landletId: null }) }));
await page.route('**/api/voice/friend-channels*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ channels: [] }) }));
await page.route('**/api/direct-messages/unread-count', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) }));

let countRequests = 0;
let friendshipRequests = 0;
let failUntil = 0; // set when the first of either request arrives
const failing = () => {
  const now = Date.now();
  if (!failUntil) failUntil = now + 1800;
  return now < failUntil;
};
await page.route('**/api/notifications/unread-count', async (route) => {
  countRequests += 1;
  if (failing()) { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'blip' }) }); return; }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 3 }) });
});
await page.route(/\/api\/friendships(\?|$)/, async (route) => {
  if (route.request().method() !== 'GET') { await route.continue(); return; }
  friendshipRequests += 1;
  if (failing()) { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'blip' }) }); return; }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ friendships: [{ friendshipId: 'f1', direction: 'incoming', status: 'pending', friend: { userId: 'u9', username: 'Someone' } }], nextCursor: null }) });
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const notices = await page.waitForFunction(() => {
  const el = document.getElementById('notifications-badge');
  return el && !el.hidden && el.textContent === '3';
}, null, { timeout: 30000 }).then(() => true, () => false);
const friends = await page.waitForFunction(() => {
  const el = document.getElementById('friends-badge');
  return el && !el.hidden && el.textContent === '1';
}, null, { timeout: 30000 }).then(() => true, () => false);
console.log('notices count asked again and shown after a failed first read (should be true):', notices, `(requests: ${countRequests})`);
console.log('friend requests asked again and shown after a failed first read (should be true):', friends, `(requests: ${friendshipRequests})`);

// The two deliberate 500s are logged by the browser as failed loads; anything else is a real error.
const unexpected = errors.filter((e) => !/Failed to load resource/.test(e));
await finish(browser, {
  pass: notices && friends && countRequests >= 2 && friendshipRequests >= 2 && unexpected.length === 0,
  label: '#4317: the head asks again for its notices and friend-request counts after one failed read',
  errors: unexpected,
});
