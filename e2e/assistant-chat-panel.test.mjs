// #3447 (part of #3444): a shopper taps an assistant, asks, and reads the
// reply, at phone width. Setup is e2e/assistant-look.test.mjs's: A is an
// ordinary shopper, B stands in the same landlet and is made an assistant
// account directly in the local D1 (fleet-login itself needs a deployment
// secret). B's own page stands in for the assistant's session: it calls the
// assistant inbox the way the session's polling loop would. A is made
// ID-verified the same way (the adult-only gate). A real tap on a pixel is never
// automated in this suite, so the panel is opened by the test hook the product
// tap also goes through.
import { execSync } from 'node:child_process';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Assistant Chat Shopper';
const LABEL_B = 'Assistant Chat Stand-in';
const LANDLET_ID = 'assistant-chat-landlet';
const ASSISTANT_NAME = 'Juniper';

const sessionA = await launchPage({ promptAnswer: LABEL_A, viewport: { width: 390, height: 800 } });
const sessionB = await launchPage({ promptAnswer: LABEL_B, viewport: { width: 390, height: 800 } });
const pageA = sessionA.page;
const pageB = sessionB.page;

async function fetchJson(page, path, options) {
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
const postJson = (page, path, body) => fetchJson(page, path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const sql = (statement) => execSync(`npx wrangler d1 execute higglehaven-db --local --command "${statement}"`, {
  cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
});

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;
await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Assistant Chat Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builderA.builderId }),
});
await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn');
await pageA.waitForTimeout(2500);
await pageA.waitForTimeout(2500);

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;
await fetchJson(pageB, '/api/presence', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 0, y: 0, z: 0, heading: 0, landletId: LANDLET_ID }),
});
await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn');
await pageB.waitForTimeout(2500);
await pageA.waitForTimeout(3000);

const usernameOf = async (page) => (await fetchJson(page, '/api/auth/me')).body.user.username;
const usernameA = await usernameOf(pageA);
const usernameB = await usernameOf(pageB);
const quote = (value) => value.replace(/'/g, "''");
sql(`UPDATE users SET trust_tier = 'id_verified' WHERE username = '${quote(usernameA)}'`);
sql(`UPDATE users SET is_fleet = 1, username = '${ASSISTANT_NAME}' WHERE username = '${quote(usernameB)}'`);

// B's session now acts as the assistant's: on shift.
console.log('assistant heartbeat (should be 200):', (await postJson(pageB, '/api/assistant-inbox/heartbeat')).status);
const assistantUserId = (await fetchJson(pageB, '/api/auth/me')).body.user.userId;

await pageA.waitForFunction(
  (id) => (window.__shopOtherAvatars || []).some((a) => a.builderId === id && a.assistantName && a.userId),
  builderB.builderId,
  { timeout: 20000 },
);
const seenUserId = await pageA.evaluate((id) => window.__shopOtherAvatars.find((a) => a.builderId === id).userId, builderB.builderId);
console.log('A sees the assistant by its account id (should be true):', seenUserId === assistantUserId);

// Tap the assistant: the panel opens with the disclosure and no conversation.
const tapped = await pageA.evaluate((id) => window.__testTapAssistantByUserId(id), assistantUserId);
await pageA.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
const opened = await pageA.evaluate(() => ({
  name: document.getElementById('assistant-chat-name').textContent,
  badge: document.getElementById('assistant-chat-badge').textContent,
  log: document.getElementById('assistant-chat-log').textContent,
  box: document.getElementById('assistant-chat-panel').getBoundingClientRect().toJSON(),
  closeBox: document.getElementById('assistant-chat-close').getBoundingClientRect().toJSON(),
  userSelect: getComputedStyle(document.getElementById('assistant-chat-log')).userSelect,
  vw: window.innerWidth, vh: window.innerHeight,
}));
console.log('opened:', JSON.stringify({ tapped, name: opened.name, badge: opened.badge }));
const fitsPhone = opened.box.left >= 0 && opened.box.right <= opened.vw && opened.box.bottom <= opened.vh;
// The close control is in the panel's upper-right corner.
const closeUpperRight = opened.closeBox.right > opened.box.right - 20 && opened.closeBox.top < opened.box.top + 20;

// Ask a question.
await pageA.fill('#assistant-chat-input', 'Where do I find the bakery?');
await pageA.click('#assistant-chat-send');
await pageA.waitForFunction(() => window.__assistantChat?.conversationStatus === 'open', null, { timeout: 5000 });
const reading = await pageA.evaluate(() => window.__assistantChat.status);
console.log('status while waiting:', reading);

// The assistant's session reads it and answers.
let delivered = null;
for (let i = 0; i < 20 && !delivered?.body?.message; i++) {
  delivered = await fetchJson(pageB, '/api/assistant-inbox/next');
  if (!delivered.body.message) await pageB.waitForTimeout(500);
}
console.log('assistant received:', delivered.body.message?.text);
const conversationId = delivered.body.conversationId;
await postJson(pageB, `/api/assistant-inbox/conversations/${conversationId}/reply`, { text: 'Head north past the fountain!' });
await pageA.waitForFunction(
  () => window.__assistantChat.messages.some((m) => m.sender === 'assistant' && m.text === 'Head north past the fountain!'),
  null,
  { timeout: 10000 },
);
const answered = await pageA.evaluate(() => ({ status: window.__assistantChat.status, log: document.getElementById('assistant-chat-log').textContent }));
console.log('after the reply:', JSON.stringify(answered));

// The assistant ends it: the panel says so, in words.
await postJson(pageB, `/api/assistant-inbox/conversations/${conversationId}/end`);
await pageA.waitForFunction(() => window.__assistantChat.conversationStatus === 'ended', null, { timeout: 10000 });
const ended = await pageA.evaluate(() => window.__assistantChat.status);
console.log('after the assistant ended it:', ended);

// Ask again (a new conversation), then close the panel: closing ends it, so
// the assistant is told the shopper left.
await pageA.fill('#assistant-chat-input', 'One more thing.');
await pageA.click('#assistant-chat-send');
await pageA.waitForFunction(() => window.__assistantChat?.conversationStatus === 'open', null, { timeout: 5000 });
await pageA.click('#assistant-chat-close');
await pageA.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });
let told = null;
for (let i = 0; i < 20; i++) {
  told = await fetchJson(pageB, '/api/assistant-inbox/next');
  if (told.body.ended) break;
  await pageB.waitForTimeout(300);
}
console.log('assistant told after the shopper closed the panel:', JSON.stringify(told.body));

const pass = tapped === true
  && opened.name === ASSISTANT_NAME && opened.badge === 'assistant'
  && opened.log.includes('AI assistant')
  && opened.userSelect !== 'none'
  && fitsPhone && closeUpperRight
  && /reading your message/.test(reading)
  && delivered.body.message?.text === 'Where do I find the bakery?'
  && answered.log.includes('Head north past the fountain!') && answered.status === ''
  && ended === `${ASSISTANT_NAME} ended the conversation.`
  && told.body.ended?.endedBy === 'shopper'
  && sessionA.errors.length === 0;
await finish(sessionA.browser, {
  pass,
  label: '#3447: tap an assistant, ask, read the reply, see it end, and closing the panel ends the conversation',
  errors: sessionA.errors,
});
await sessionB.browser.close();
