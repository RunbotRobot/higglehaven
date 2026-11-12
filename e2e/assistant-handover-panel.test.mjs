// #3448 (part of #3444): when an assistant passes a conversation to another one
// on shift, the shopper's panel says who they are talking to now and that nothing
// has to be repeated, and each reply names the assistant who wrote it. The server
// side (the hand-over itself, its refusals, the new assistant's inbox) is covered
// by worker/assistant-chat.test.js; this is the panel, at phone width.
//
// Setup is e2e/assistant-chat-panel.test.mjs's: A is an ordinary shopper made
// ID-verified, B stands in A's landlet and is made the assistant "Juniper", and a
// third account C is made the assistant "Clover" and put on shift. B's and C's
// own pages stand in for the two assistants' sessions.
import { execSync } from 'node:child_process';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Handover Shopper';
const LABEL_B = 'Handover Stand-in One';
const LABEL_C = 'Handover Stand-in Two';
const LANDLET_ID = 'assistant-handover-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A, viewport: { width: 390, height: 800 } });
const sessionB = await launchPage({ promptAnswer: LABEL_B, viewport: { width: 390, height: 800 } });
const sessionC = await launchPage({ promptAnswer: LABEL_C, viewport: { width: 390, height: 800 } });
const pageA = sessionA.page;
const pageB = sessionB.page;
const pageC = sessionC.page;

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
const quote = (value) => value.replace(/'/g, "''");
const usernameOf = async (page) => (await fetchJson(page, '/api/auth/me')).body.user.username;

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;
await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ landletId: LANDLET_ID, name: 'Assistant Handover Landlet', areaM2: 1000, status: 'claimed', ownerBuilderId: builderA.builderId }),
});
await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn');
await pageA.waitForTimeout(5000);

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

// C never needs to be seen in the world: it only has to be an assistant on shift.
await chooseIdentity(pageC, { mode: 'build', label: LABEL_C, isNew: true });

const usernameA = await usernameOf(pageA);
const usernameB = await usernameOf(pageB);
const usernameC = await usernameOf(pageC);
sql(`UPDATE users SET trust_tier = 'id_verified' WHERE username = '${quote(usernameA)}'`);
sql(`UPDATE users SET is_fleet = 1, username = 'Juniper' WHERE username = '${quote(usernameB)}'`);
sql(`UPDATE users SET is_fleet = 1, username = 'Clover' WHERE username = '${quote(usernameC)}'`);
console.log('Juniper heartbeat (should be 200):', (await postJson(pageB, '/api/assistant-inbox/heartbeat')).status);
console.log('Clover heartbeat (should be 200):', (await postJson(pageC, '/api/assistant-inbox/heartbeat')).status);
const juniperUserId = (await fetchJson(pageB, '/api/auth/me')).body.user.userId;
const cloverUserId = (await fetchJson(pageC, '/api/auth/me')).body.user.userId;

await pageA.waitForFunction(
  (id) => (window.__shopOtherAvatars || []).some((a) => a.builderId === id && a.assistantName && a.userId),
  builderB.builderId,
  { timeout: 20000 },
);

// A asks Juniper; Juniper answers.
await pageA.evaluate((id) => window.__testTapAssistantByUserId(id), juniperUserId);
await pageA.waitForSelector('#assistant-chat-panel:not([hidden])', { timeout: 5000 });
await pageA.fill('#assistant-chat-input', 'How do I sell a hat?');
await pageA.click('#assistant-chat-send');
await pageA.waitForFunction(() => window.__assistantChat?.conversationStatus === 'open', null, { timeout: 5000 });
let delivered = null;
for (let i = 0; i < 20 && !delivered?.body?.message; i++) {
  delivered = await fetchJson(pageB, '/api/assistant-inbox/next');
  if (!delivered.body.message) await pageB.waitForTimeout(500);
}
const conversationId = delivered.body.conversationId;
await postJson(pageB, `/api/assistant-inbox/conversations/${conversationId}/reply`, { text: 'Let me get Clover, who knows selling best.' });
await pageA.waitForFunction(
  () => window.__assistantChat.messages.some((m) => m.sender === 'assistant'),
  null,
  { timeout: 10000 },
);
const beforeHandover = await pageA.evaluate(() => ({
  name: window.__assistantChat.assistantName,
  notice: window.__assistantChat.handoverNotice,
}));
console.log('before the hand-over:', JSON.stringify(beforeHandover));

// Juniper passes the conversation to Clover (named, as the session script does).
const handed = await postJson(pageB, `/api/assistant-inbox/conversations/${conversationId}/handover`, { toAssistantUserId: cloverUserId });
console.log('hand-over (should be 200):', handed.status, JSON.stringify(handed.body));

// The shopper's open panel learns of it on its own and says who they are with now.
await pageA.waitForFunction(() => window.__assistantChat.assistantName === 'Clover', null, { timeout: 15000 });
const afterHandover = await pageA.evaluate(() => ({
  name: window.__assistantChat.assistantName,
  notice: window.__assistantChat.handoverNotice,
  log: document.getElementById('assistant-chat-log').textContent,
  noteCount: document.querySelectorAll('#assistant-chat-log .assistant-chat-note').length,
  box: document.getElementById('assistant-chat-panel').getBoundingClientRect().toJSON(),
  vw: window.innerWidth, vh: window.innerHeight,
}));
console.log('after the hand-over:', JSON.stringify({ ...afterHandover, box: undefined }));
const fitsPhone = afterHandover.box.left >= 0 && afterHandover.box.right <= afterHandover.vw && afterHandover.box.bottom <= afterHandover.vh;

// Clover's session is handed the conversation so far, once, and answers; the
// reply is labelled with Clover's name and the earlier one keeps Juniper's.
let handoverSeen = null;
for (let i = 0; i < 20 && !handoverSeen?.body?.handover; i++) {
  handoverSeen = await fetchJson(pageC, '/api/assistant-inbox/next');
  if (!handoverSeen.body.handover) await pageC.waitForTimeout(500);
}
console.log('Clover was handed the history:', JSON.stringify({
  from: handoverSeen.body.handover?.fromAssistant,
  texts: handoverSeen.body.handover?.history?.map((m) => m.text),
}));
await postJson(pageC, `/api/assistant-inbox/conversations/${conversationId}/reply`, { text: 'Open Sell mode and tap Add a product.' });
await pageA.waitForFunction(
  () => document.getElementById('assistant-chat-log').textContent.includes('Open Sell mode and tap Add a product.'),
  null,
  { timeout: 15000 },
);
const whoWrote = await pageA.evaluate(() => [...document.querySelectorAll('#assistant-chat-log .assistant-chat-message')]
  .map((row) => ({ who: row.querySelector('.who').textContent, text: row.lastChild.textContent })));
console.log('who wrote each line:', JSON.stringify(whoWrote));

const unexpectedErrors = sessionA.errors;
const pass = beforeHandover.name === 'Juniper' && beforeHandover.notice === null
  && handed.status === 200
  && afterHandover.name === 'Clover'
  && afterHandover.notice === 'Juniper passed your conversation to Clover, who can see everything you wrote.'
  && afterHandover.log.includes('Juniper passed your conversation to Clover, who can see everything you wrote.')
  && afterHandover.noteCount === 1 // the hand-over line, once (the AI disclosure is only shown before a conversation starts)
  && fitsPhone
  && handoverSeen.body.handover?.fromAssistant === 'Juniper'
  && handoverSeen.body.handover?.history?.some((m) => m.text === 'How do I sell a hat?')
  && whoWrote.some((line) => line.who === 'Juniper' && line.text === 'Let me get Clover, who knows selling best.')
  && whoWrote.some((line) => line.who === 'Clover' && line.text === 'Open Sell mode and tap Add a product.')
  && whoWrote.some((line) => line.who === 'You' && line.text === 'How do I sell a hat?')
  && unexpectedErrors.length === 0;
await finish(sessionA.browser, {
  pass,
  label: '#3448: after an assistant passes a conversation on, the open panel says who the shopper is with now and who wrote each reply',
  errors: unexpectedErrors,
});
await sessionB.browser.close();
await sessionC.browser.close();
