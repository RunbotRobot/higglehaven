import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, extractSessionCookie, withSession, signupBuilder } from './test-helpers.js';
import { pruneStaleAssistantChat, CONTACT_KEPT_MS } from './lib/assistant-chat.js';

// #3531 (part of #3444): an assistant introduces itself once per person. Whether
// it has spoken to this shopper before arrives with each thing it is handed
// (`firstContact`, `lastSpokeAt`), survives the 30-minute message retention, and
// the first message of a conversation carries what is left of earlier ones.
// Own file because it sets env.FLEET_ACCESS_KEY to mint assistant accounts.
const FLEET_KEY = 'test-fleet-access-key-assistant-contact';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.FLEET_ACCESS_KEY = FLEET_KEY;
});
afterAll(() => { env.FLEET_ACCESS_KEY = undefined; });

async function fleetLogin(name) {
  const response = await SELF.fetch('https://higglehaven.test/api/auth/fleet-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-key': FLEET_KEY, 'cf-connecting-ip': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ name }),
  });
  const body = await response.json();
  return { userId: body.user.userId, session: (options) => withSession(extractSessionCookie(response), options) };
}

async function adult(label) {
  const person = await signupBuilder(label);
  await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE email = ?").bind(person.email).run();
  const row = await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(person.email).first();
  return { ...person, userId: row.user_id };
}

const post = (session, path, body) => api(path, session({ method: 'POST', body: JSON.stringify(body ?? {}) }));
let juniper;
let clover;
beforeAll(async () => {
  juniper = await fleetLogin('assistant-juniper');
  clover = await fleetLogin('assistant-clover');
});
const goOnShift = (assistant) => post(assistant.session, '/assistant-inbox/heartbeat');
const next = (assistant) => api('/assistant-inbox/next', assistant.session());
const start = (person, assistant, text) => post(person.session, '/assistant-chat/start', { assistantUserId: assistant.userId, text });
async function clear() {
  await env.DB.prepare("UPDATE assistant_conversations SET status = 'ended', ended_by = 'timeout', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), assistant_told_ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'open'").run();
  await env.DB.prepare('DELETE FROM assistant_questions').run();
}

describe('first contact (#3531)', () => {
  it('is true until the assistant has answered, then false, across separate conversations, with the earlier exchange carried', async () => {
    await clear();
    await goOnShift(juniper);
    const shopper = await adult('contact-returning');
    const first = await start(shopper, juniper, 'Where is the bakery?');
    const handed = await next(juniper);
    expect(handed.body).toMatchObject({ firstContact: true, lastSpokeAt: null, history: [] });
    expect(handed.body.earlier).toEqual([]);
    // Asking again before it answers is still a first contact: it has not spoken yet.
    await post(shopper.session, '/assistant-chat/send', { text: 'Hello?' });
    expect((await next(juniper)).body).toMatchObject({ firstContact: true });

    const conversationId = first.body.conversation.conversationId;
    await post(juniper.session, `/assistant-inbox/conversations/${conversationId}/reply`, { text: 'North past the fountain!' });
    await post(shopper.session, '/assistant-chat/send', { text: 'Thanks!' });
    const second = await next(juniper);
    expect(second.body.firstContact).toBe(false);
    expect(typeof second.body.lastSpokeAt).toBe('string');
    // `earlier` is only for the first message of a conversation.
    expect(second.body.earlier).toBeUndefined();

    // The conversation ends; a new one starts. Not a stranger, and the last exchange comes along.
    await post(shopper.session, '/assistant-chat/end');
    await next(juniper); // told it ended
    expect((await start(shopper, juniper, 'One more question')).response.status).toBe(201);
    const again = await next(juniper);
    expect(again.body.firstContact).toBe(false);
    expect(again.body.history).toEqual([]);
    expect(again.body.earlier.map((m) => m.text)).toEqual(['Where is the bakery?', 'Hello?', 'North past the fountain!', 'Thanks!']);
    await clear();
  });

  it('is per assistant: another one has not met them, and a handover reports it too', async () => {
    await clear();
    await goOnShift(juniper);
    await goOnShift(clover);
    const shopper = await adult('contact-pair');
    const started = await start(shopper, juniper, 'Hi there');
    await next(juniper);
    const conversationId = started.body.conversation.conversationId;
    await post(juniper.session, `/assistant-inbox/conversations/${conversationId}/reply`, { text: 'Hello!' });
    // Clover, who has never answered this person, is handed the conversation.
    expect((await post(juniper.session, `/assistant-inbox/conversations/${conversationId}/handover`, { toAssistantUserId: clover.userId })).response.status).toBe(200);
    const handover = await next(clover);
    expect(handover.body.handover).toMatchObject({ fromAssistant: 'Juniper', firstContact: true, lastSpokeAt: null });
    // Juniper, in contrast, knows them.
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM assistant_contacts WHERE shopper_user_id = ? AND assistant_user_id = ?').bind(shopper.userId, juniper.userId).first();
    expect(row.n).toBe(1);
    await clear();
  });

  it('applies to a left question, and an answer to it counts as having spoken', async () => {
    await clear();
    await goOnShift(juniper);
    const shopper = await adult('contact-question');
    await post(shopper.session, '/assistant-chat/question', { text: 'Can I sell a hat?' });
    const handed = await next(juniper);
    expect(handed.body.question).toMatchObject({ firstContact: true, lastSpokeAt: null, earlier: [] });
    await post(juniper.session, `/assistant-inbox/questions/${handed.body.question.questionId}/answer`, { text: 'Yes, in Sell mode.' });
    await post(shopper.session, '/assistant-chat/question/close');
    await post(shopper.session, '/assistant-chat/question', { text: 'And a scarf?' });
    const again = await next(juniper);
    expect(again.body.question).toMatchObject({ firstContact: false, text: 'And a scarf?' });
    await clear();
  });

  it('is forgotten 30 days after the assistant last spoke, and holds no message text', async () => {
    await clear();
    await goOnShift(juniper);
    const shopper = await adult('contact-forgotten');
    const started = await start(shopper, juniper, 'Hi');
    await next(juniper);
    await post(juniper.session, `/assistant-inbox/conversations/${started.body.conversation.conversationId}/reply`, { text: 'Hello!' });
    const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('assistant_contacts')").all()).results.map((c) => c.name);
    expect(columns.sort()).toEqual(['assistant_user_id', 'first_spoke_at', 'last_spoke_at', 'shopper_user_id']);
    const old = new Date(Date.now() - CONTACT_KEPT_MS - 60_000).toISOString();
    await env.DB.prepare('UPDATE assistant_contacts SET last_spoke_at = ? WHERE shopper_user_id = ?').bind(old, shopper.userId).run();
    // Past the window it already reads as a first contact, before any sweep.
    await post(shopper.session, '/assistant-chat/end');
    await next(juniper);
    await start(shopper, juniper, 'Back again');
    expect((await next(juniper)).body).toMatchObject({ firstContact: true, lastSpokeAt: null });
    await pruneStaleAssistantChat(env.DB);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM assistant_contacts WHERE shopper_user_id = ?').bind(shopper.userId).first();
    expect(left.n).toBe(0);
    await clear();
  });
});
