// #3555 (interface week, #3539): adding a friend used to mean Friends > "+ Add
// Friend", a second popup over the Friends leaf, and a name typed from memory.
// Now a tap on a person's avatar in Shop offers friendship (the typed name stays
// in the Friends leaf as the fallback for someone not nearby). A real tap needs
// aiming at a pixel, which this suite never automates, so window.__testTapPersonByBuilderId
// reaches the same flow for a person the world is drawing (see main.js).
//
// A fake person is drawn the way shop-other-avatar-builtin-motion.test.mjs does
// (the presence poll is rewritten), and POST /api/friendships is answered by the
// test, so no real account is ever befriended. Checks:
//   - an assistant is not offered friendship (it answers a tap with its chat);
//   - the offer is one in-app confirmation titled for the person, with the safe
//     choice focused, and nothing is sent when it is dismissed;
//   - Send request posts exactly one request naming that person's builder id,
//     closes the confirmation and shows a note that fades by itself;
//   - a refusal stays in the confirmation, where the person tapped, in the
//     server's own words, and nothing says how a request was received.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Tap Person Tester';
const LANDLET_ID = 'tap-person-landlet';
const FAKE_ID = 'fake-person-to-befriend';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });

let nativeDialogs = 0;
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => { nativeDialogs += 1; await dialog.dismiss(); });

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
const builder = (await fetchJson('/api/builders/me')).body.builder;
const created = await fetchJson('/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Tap Person Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builder.builderId }),
});
console.log('landlet created (status should be 201):', created.status);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(3000);

// One ordinary person and one assistant, drawn beside the shopper.
await page.route('**/api/presence*', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch().catch(() => null);
  if (!res) return;
  const body = await res.json();
  body.avatars = [
    ...(body.avatars ?? []),
    { builderId: FAKE_ID, userId: 'fake-person-user', x: 3, y: 4, z: 0, heading: 0, equippedAvatar: null, equippedAnimation: null },
    { builderId: 'fake-assistant-builder', userId: 'fake-assistant-user', x: 6, y: 4, z: 0, heading: 0, assistant: { name: 'Juniper', busy: false }, equippedAvatar: null, equippedAnimation: null },
  ];
  await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' }).catch(() => {});
});

// POST /api/friendships is the test's to answer: it counts what was sent and
// can be told to refuse.
const sent = [];
let refuseWith = null;
await page.route('**/api/friendships', async (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  sent.push(JSON.parse(route.request().postData() ?? '{}'));
  if (refuseWith) {
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: refuseWith }) });
  }
  return route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ friendship: { friendshipId: 'friendship-fake', status: 'pending', direction: 'outgoing', otherBuilderId: FAKE_ID, otherLabel: 'Fake' } }),
  });
});

const drawn = await page.waitForFunction(
  (ids) => ids.every((id) => (window.__shopOtherAvatars ?? []).some((a) => a.builderId === id)),
  [FAKE_ID, 'fake-assistant-builder'],
  { timeout: 25000 },
).then(() => true).catch(() => false);
console.log('the person and the assistant are drawn (should be true):', drawn);

const confirmVisible = () => page.evaluate(() => document.getElementById('confirm-modal').classList.contains('visible'));

// An assistant is not offered friendship: its tap is the chat, not this flow.
const assistantRefused = await page.evaluate(() => window.__testTapPersonByBuilderId('fake-assistant-builder'));
console.log('a tap on an assistant is not a friendship offer (should be false):', assistantRefused);
console.log('someone not drawn is not offered either (should be false):', await page.evaluate(() => window.__testTapPersonByBuilderId('nobody-here')));

// The offer: one in-app confirmation, safe choice focused, native dialogs untouched.
const opened = await page.evaluate((id) => window.__testTapPersonByBuilderId(id), FAKE_ID);
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const title = (await page.textContent('#confirm-modal-title')).trim();
const confirmLabel = (await page.textContent('#confirm-modal-confirm-btn')).trim();
const cancelLabel = (await page.textContent('#confirm-modal-cancel-btn')).trim();
const focusOnSafeChoice = await page.evaluate(() => document.activeElement?.id === 'confirm-modal-cancel-btn');
console.log('offer opened:', opened, '| title:', title, '| buttons:', confirmLabel, '/', cancelLabel, '| focus on Not now:', focusOnSafeChoice);

// Dismissed: nothing is sent.
await page.click('#confirm-modal-cancel-btn');
await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
const sentAfterDismiss = sent.length;

// Send request: exactly one request, naming the person; the confirmation closes
// and a note fades by itself.
await page.evaluate((id) => window.__testTapPersonByBuilderId(id), FAKE_ID);
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
// The word is said in the confirmation itself, then it closes by itself.
await page.waitForFunction(() => /sent/i.test(document.getElementById('confirm-modal-status')?.textContent || ''), null, { timeout: 5000 });
const noteText = (await page.textContent('#confirm-modal-status')).trim();
const noteFades = await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 8000 })
  .then(() => true).catch(() => false);
const sentBody = sent[0];

// A refusal stays in the confirmation, in the server's own words, until dismissed.
refuseWith = 'A friendship or pending request already exists between these builders';
await page.evaluate((id) => window.__testTapPersonByBuilderId(id), FAKE_ID);
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(
  () => document.getElementById('confirm-modal-status').textContent.includes('already exists'),
  null, { timeout: 5000 },
);
const refusalShownInPlace = await confirmVisible();
const refusalText = (await page.textContent('#confirm-modal-status')).trim();
await page.click('#confirm-modal-cancel-btn');

console.log('requests sent after dismissing (should be 0):', sentAfterDismiss);
console.log('request body:', JSON.stringify(sentBody), '| requests so far (success then refusal):', sent.length);
console.log('confirmation after sending:', noteText, '| closes by itself:', noteFades);
console.log('refusal stays in the confirmation:', refusalShownInPlace, '|', refusalText);
console.log('native dialogs raised (should be 0):', nativeDialogs);
// The refusal the test provokes shows in the browser console as one 409; nothing else is expected.
const unexpectedErrors = errors.filter((message) => !/status of 409/.test(String(message)));

const pass = drawn && assistantRefused === false && opened === true
  && /Offer friendship/.test(title) && confirmLabel === 'Send request' && cancelLabel === 'Not now' && focusOnSafeChoice
  && sentAfterDismiss === 0
  && sentBody?.recipientBuilderId === FAKE_ID && /request sent/i.test(noteText) && noteFades
  && sent.length === 2 && refusalShownInPlace && refusalText.includes('already exists')
  && nativeDialogs === 0 && unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'tapping a person in Shop offers friendship in one in-app confirmation (#3555)', errors: unexpectedErrors });
