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

// #3448: when the assistant asked is busy, the server names one who is free and
// the panel offers a tap to go to them. The server's answer is faked here (the
// real one is covered by worker/assistant-chat.test.js); the panel is real.
await pageA.evaluate((id) => window.__testTapAssistantByUserId(id), assistantUserId);
await pageA.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
await pageA.route('**/api/assistant-chat/start', (route) => route.fulfill({
  status: 409,
  contentType: 'application/json',
  body: JSON.stringify({
    error: `${ASSISTANT_NAME} is helping someone else right now.`,
    assistantBusy: true,
    freeAssistant: { userId: 'assistant-user-clover', name: 'Clover' },
  }),
}));
await pageA.fill('#assistant-chat-input', 'Is anyone free?');
await pageA.click('#assistant-chat-send');
await pageA.waitForSelector('#assistant-chat-offer:not([hidden])', { timeout: 5000 });
const offerShown = await pageA.evaluate(() => ({
  text: document.getElementById('assistant-chat-offer').textContent,
  status: window.__assistantChat.status,
  kept: document.getElementById('assistant-chat-input').value,
}));
await pageA.click('#assistant-chat-offer');
const afterOffer = await pageA.evaluate(() => ({
  name: window.__assistantChat.assistantName,
  offerHidden: document.getElementById('assistant-chat-offer').hidden,
  status: window.__assistantChat.status,
  kept: document.getElementById('assistant-chat-input').value,
}));
console.log('offer:', JSON.stringify({ offerShown, afterOffer }));
await pageA.unroute('**/api/assistant-chat/start');
await pageA.click('#assistant-chat-close');
await pageA.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });

// #3448: when nobody is free, leave the question. The refusal is faked (the real
// ones are in worker/assistant-chat.test.js); the leave, the place in line, the
// answer and the Settings entry are all real.
await pageA.evaluate((id) => window.__testTapAssistantByUserId(id), assistantUserId);
await pageA.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
await pageA.route('**/api/assistant-chat/start', (route) => route.fulfill({
  status: 409,
  contentType: 'application/json',
  body: JSON.stringify({ error: `${ASSISTANT_NAME} is helping someone else right now.`, assistantBusy: true, freeAssistant: null }),
}));
await pageA.fill('#assistant-chat-input', 'Can I sell a hat?');
await pageA.click('#assistant-chat-send');
await pageA.waitForSelector('#assistant-chat-leave:not([hidden])', { timeout: 5000 });
await pageA.unroute('**/api/assistant-chat/start');
const leaveOffered = await pageA.evaluate(() => ({
  label: document.getElementById('assistant-chat-leave').textContent,
  kept: document.getElementById('assistant-chat-input').value,
}));
await pageA.click('#assistant-chat-leave');
await pageA.waitForFunction(() => window.__assistantChat?.question?.status === 'waiting', null, { timeout: 5000 });
const inLine = await pageA.evaluate(() => ({
  question: window.__assistantChat.question,
  status: window.__assistantChat.status,
  formHidden: document.getElementById('assistant-chat-form').hidden,
  withdraw: document.getElementById('assistant-chat-withdraw').textContent,
  box: document.getElementById('assistant-chat-panel').getBoundingClientRect().toJSON(),
  vw: window.innerWidth, vh: window.innerHeight,
}));
console.log('left question:', JSON.stringify({ leaveOffered, inLine: { ...inLine, box: undefined } }));
const questionPanelFits = inLine.box.left >= 0 && inLine.box.right <= inLine.vw && inLine.box.bottom <= inLine.vh;

// Closing the panel keeps the place. The assistant's session is handed the question and answers it.
await pageA.click('#assistant-chat-close');
await pageA.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });
let handedQuestion = null;
for (let i = 0; i < 20 && !handedQuestion?.body?.question; i++) {
  handedQuestion = await fetchJson(pageB, '/api/assistant-inbox/next');
  if (!handedQuestion.body.question) await pageB.waitForTimeout(300);
}
console.log('assistant was handed the left question:', handedQuestion.body.question?.text);
const answerPosted = await postJson(pageB, `/api/assistant-inbox/questions/${handedQuestion.body.question.questionId}/answer`, { text: 'Yes! Open Sell mode and add it.' });

// The shopper comes back through Settings (no assistant needs to be in view) and reads it.
await pageA.click('#account-menu-toggle');
await pageA.click('#settings-btn');
await pageA.waitForSelector('#settings-assistant-btn', { state: 'visible', timeout: 5000 });
await pageA.click('#settings-assistant-btn');
await pageA.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
await pageA.waitForFunction(() => window.__assistantChat?.question?.status === 'answered', null, { timeout: 5000 });
const readAnswer = await pageA.evaluate(() => ({
  log: document.getElementById('assistant-chat-log').textContent,
  name: window.__assistantChat.assistantName,
  withdraw: document.getElementById('assistant-chat-withdraw').textContent,
  settingsOpen: document.getElementById('settings-modal').classList.contains('visible'),
}));
console.log('answer read after coming back:', JSON.stringify(readAnswer));
await pageA.click('#assistant-chat-withdraw');
await pageA.waitForFunction(() => window.__assistantChat?.question === null, null, { timeout: 5000 });
await pageA.click('#assistant-chat-close');
await pageA.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 5000 });

// Blocking an assistant is blocking anyone: reopen the panel, press Block, confirm
// in the in-app dialog. The panel closes and a new question is refused with the
// same plain message a stranger would get.
await pageA.evaluate((id) => window.__testTapAssistantByUserId(id), assistantUserId);
await pageA.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
const blockShown = await pageA.evaluate(() => !document.getElementById('assistant-chat-block').hidden);
await pageA.click('#assistant-chat-block');
await pageA.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await pageA.click('#confirm-modal-confirm-btn');
await pageA.waitForSelector('#assistant-chat-panel[hidden]', { state: 'attached', timeout: 10000 });
const afterBlock = await postJson(pageA, '/api/assistant-chat/start', { assistantUserId, text: 'Hello again' });
console.log('start after blocking (should be 403):', afterBlock.status, afterBlock.body.error);

// The refused question above is a deliberate 403, which the browser logs as a
// failed resource load; it is the only page error this test expects.
const unexpectedErrors = sessionA.errors.filter((error) => !/status of (403|409)/.test(String(error)));
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
  && /helping someone else/.test(offerShown.status) && offerShown.text === 'Clover is free. Talk to Clover instead' && offerShown.kept === 'Is anyone free?'
  && afterOffer.name === 'Clover' && afterOffer.offerHidden && afterOffer.status === '' && afterOffer.kept === 'Is anyone free?'
  && leaveOffered.label === 'Leave my question for the assistants' && leaveOffered.kept === 'Can I sell a hat?'
  && inLine.question.position === 1 && /number 1 in line/.test(inLine.status) && /your place is kept/.test(inLine.status)
  && inLine.formHidden && inLine.withdraw === 'Take my question back' && questionPanelFits
  && handedQuestion.body.question?.text === 'Can I sell a hat?' && answerPosted.status === 201
  && readAnswer.log.includes('Yes! Open Sell mode and add it.') && readAnswer.log.includes('Can I sell a hat?')
  && readAnswer.withdraw === 'Done' && !readAnswer.settingsOpen
  && blockShown && afterBlock.status === 403 && afterBlock.body.error === "You can't message this person."
  && unexpectedErrors.length === 0;
await finish(sessionA.browser, {
  pass,
  label: '#3447/#3448: tap an assistant, ask, read the reply, see it end, closing ends the conversation; leave a question, keep the place, read the answer from Settings; Block blocks the assistant',
  errors: unexpectedErrors,
});
await sessionB.browser.close();
