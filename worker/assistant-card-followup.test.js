// #3532 part 2 (part of #3444): a shopper who passed something to the team
// through an assistant hears what became of it, once, in a sentence written
// for them. A card closed without that sentence tells nobody.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, extractSessionCookie, withSession, signupBuilder } from './test-helpers.js';

const FLEET_KEY = 'test-fleet-access-key-card-followup';
const CR_KEY = 'test-control-room-key-card-followup';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.FLEET_ACCESS_KEY = FLEET_KEY;
  env.CONTROL_ROOM_API_KEY = CR_KEY;
});
afterAll(() => { env.FLEET_ACCESS_KEY = undefined; env.CONTROL_ROOM_API_KEY = undefined; });

async function fleetLogin(name) {
  const response = await SELF.fetch('https://higglehaven.test/api/auth/fleet-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-key': FLEET_KEY, 'cf-connecting-ip': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ name }),
  });
  const body = await response.json();
  return { userId: body.user.userId, session: (options) => withSession(extractSessionCookie(response), options) };
}

const post = (session, path, body) => api(path, session({ method: 'POST', body: JSON.stringify(body ?? {}) }));
const patchCard = (id, fields) => api(`/control-room/tasks/${id}`, {
  method: 'PATCH',
  headers: { 'x-control-room-key': CR_KEY },
  body: JSON.stringify({ caller: 'higglehaven7', ...fields }),
});

// A shopper starts a conversation and the assistant passes it on as a card.
async function fileCard(label, kind = 'problem') {
  const assistant = await fleetLogin('assistant-juniper');
  await post(assistant.session, '/assistant-inbox/heartbeat');
  const person = await signupBuilder(label);
  await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE email = ?").bind(person.email).run();
  const row = await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(person.email).first();
  await env.DB.prepare("UPDATE assistant_conversations SET status = 'ended', ended_by = 'timeout', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), assistant_told_ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'open'").run();
  const started = await post(person.session, '/assistant-chat/start', { assistantUserId: assistant.userId, text: 'The toilet looks jagged from far away.' });
  const conversationId = started.body.conversation.conversationId;
  const filed = await post(assistant.session, `/assistant-inbox/conversations/${conversationId}/escalate`, { summary: 'Toilet looks jagged.', kind });
  expect(filed.response.status).toBe(201);
  return { person, userId: row.user_id, cardId: filed.body.cardId };
}

async function notices(person) {
  const { body } = await api('/notifications', person.session());
  return (Array.isArray(body) ? body : (body.notifications ?? [])).map((n) => n.message);
}

describe('telling the shopper what became of a card', () => {
  it('records who to tell when the assistant files the card', async () => {
    const { cardId, userId } = await fileCard('cf-record', 'suggestion');
    const row = await env.DB.prepare('SELECT * FROM assistant_card_followups WHERE card_id = ?').bind(cardId).first();
    expect(row).toMatchObject({ shopper_user_id: userId, kind: 'suggestion', told_at: null });
  });

  it('sends one notification when the card is done with a sentence for them, and only once', async () => {
    const { person, cardId } = await fileCard('cf-done');
    const line = 'The toilet you reported now looks right from far away.';
    const first = await patchCard(cardId, { status: 'done', shopperLine: line });
    expect(first.response.status).toBe(200);
    expect(first.body.shopperTold).toBe(true);
    expect(await notices(person)).toContain(`About what you passed on: ${line}`);
    // Done again, or a second sentence: nothing more is sent.
    const again = await patchCard(cardId, { status: 'done', shopperLine: 'Another sentence entirely.' });
    expect(again.body.shopperTold).toBe(false);
    const all = (await notices(person)).filter((m) => m.startsWith('About what you passed on'));
    expect(all).toHaveLength(1);
  });

  it('tells nobody when the card is closed without a sentence', async () => {
    const { person, cardId } = await fileCard('cf-silent');
    const done = await patchCard(cardId, { status: 'done' });
    expect(done.response.status).toBe(200);
    expect(done.body.shopperTold).toBe(false);
    expect((await notices(person)).some((m) => m.startsWith('About what you passed on'))).toBe(false);
  });

  it('refuses a sentence with internals in it, or one sent without done', async () => {
    const { cardId } = await fileCard('cf-refuse');
    expect((await patchCard(cardId, { status: 'done', shopperLine: 'Fixed in #3527 today.' })).response.status).toBe(400);
    expect((await patchCard(cardId, { status: 'done', shopperLine: 'See src/build/scene.js.' })).response.status).toBe(400);
    expect((await patchCard(cardId, { shopperLine: 'Thanks for the idea.' })).response.status).toBe(400);
    const row = await env.DB.prepare('SELECT told_at FROM assistant_card_followups WHERE card_id = ?').bind(cardId).first();
    expect(row.told_at).toBeNull();
  });

  it('does nothing for a card an assistant did not file', async () => {
    const { response, body } = await api('/control-room/tasks', {
      method: 'POST',
      headers: { 'x-control-room-key': CR_KEY },
      body: JSON.stringify({ from: 'higglehaven7', title: 'An ordinary card' }),
    });
    expect(response.status).toBe(201);
    const done = await patchCard(body.task.id, { status: 'done', shopperLine: 'Thanks for the idea.' });
    expect(done.response.status).toBe(200);
    expect(done.body.shopperTold).toBe(false);
  });
});
