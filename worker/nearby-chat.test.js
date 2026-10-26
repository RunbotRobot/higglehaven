// #2779 (sub-issue of #2777, proximity voice chat + general text chat):
// GET/POST /nearby-chat. Mirrors direct-messages.test.js's own
// signupIdVerifiedBuilder helper (the id_verified bar docs/SPEC.md §6
// requires for this feature too) and presence.test.js's own setPresence
// helper (the landlet-derivation anti-spoof pattern, #2269, this endpoint
// reuses verbatim via callersCurrentLandletId in worker/lib/social.js).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function signupIdVerifiedBuilder(label) {
  const builder = await signupBuilder(label);
  await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)")
    .bind(builder.builderId).run();
  return builder;
}

async function setPresence(builderId, { landletId, updatedAt = new Date().toISOString() } = {}) {
  await env.DB.prepare(`
    INSERT INTO avatar_presence (builder_id, landlet_id, x, y, z, heading, flying, updated_at)
    VALUES (?, ?, 0, 0, 0, 0, 0, ?)
    ON CONFLICT (builder_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
  `).bind(builderId, landletId, updatedAt).run();
}

describe('Nearby chat (#2779)', () => {
  describe('POST /nearby-chat', () => {
    it('requires a session', async () => {
      const anon = await api('/nearby-chat', { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
      expect(anon.response.status).toBe(401);
    });

    it('rejects a sender who is not id_verified', async () => {
      const alice = await signupBuilder('nearby-chat-unverified-alice'); // only credit_card
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-1' });
      const rejected = await api('/nearby-chat', alice.session({
        method: 'POST', body: JSON.stringify({ text: 'hi' }),
      }));
      expect(rejected.response.status).toBe(403);
      expect(rejected.body.idVerificationRequired).toBe(true);
    });

    it('rejects a sender with no recent presence row', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-no-presence-alice');
      const rejected = await api('/nearby-chat', alice.session({
        method: 'POST', body: JSON.stringify({ text: 'hi' }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects a sender whose presence has gone stale', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-stale-alice');
      await setPresence(alice.builderId, {
        landletId: 'nearby-chat-landlet-stale', updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const rejected = await api('/nearby-chat', alice.session({
        method: 'POST', body: JSON.stringify({ text: 'hi' }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects text over 280 characters', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-toolong-alice');
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-toolong' });
      const rejected = await api('/nearby-chat', alice.session({
        method: 'POST', body: JSON.stringify({ text: 'x'.repeat(281) }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('sends a message, scoped to the sender\'s current landlet', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-send-alice');
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-send' });

      const sent = await api('/nearby-chat', alice.session({
        method: 'POST', body: JSON.stringify({ text: 'Hello nearby!' }),
      }));
      expect(sent.response.status).toBe(201);
      expect(sent.body.message).toMatchObject({ builderId: alice.builderId, text: 'Hello nearby!' });
      expect(sent.body.message.messageId).toBeTruthy();
      expect(sent.body.message.createdAt).toBeTruthy();
    });
  });

  describe('GET /nearby-chat', () => {
    it('requires a session', async () => {
      const anon = await api('/nearby-chat');
      expect(anon.response.status).toBe(401);
    });

    it('rejects a poller who is not id_verified', async () => {
      const alice = await signupBuilder('nearby-chat-poll-unverified-alice');
      const rejected = await api('/nearby-chat', alice.session());
      expect(rejected.response.status).toBe(403);
    });

    it('returns an empty list with a null cursor and null landletId when the caller has no recent presence row', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-poll-no-presence-alice');
      const got = await api('/nearby-chat', alice.session());
      expect(got.response.status).toBe(200);
      expect(got.body).toEqual({ messages: [], nextCursor: null, landletId: null });
    });

    it('only returns messages from the caller\'s own landlet, not another one', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-scope-alice');
      const bob = await signupIdVerifiedBuilder('nearby-chat-scope-bob');
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-scope-a' });
      await setPresence(bob.builderId, { landletId: 'nearby-chat-landlet-scope-b' });

      await api('/nearby-chat', alice.session({ method: 'POST', body: JSON.stringify({ text: 'from alice landlet A' }) }));
      await api('/nearby-chat', bob.session({ method: 'POST', body: JSON.stringify({ text: 'from bob landlet B' }) }));

      const aliceView = await api('/nearby-chat', alice.session());
      expect(aliceView.body.messages).toHaveLength(1);
      expect(aliceView.body.messages[0].text).toBe('from alice landlet A');

      const bobView = await api('/nearby-chat', bob.session());
      expect(bobView.body.messages).toHaveLength(1);
      expect(bobView.body.messages[0].text).toBe('from bob landlet B');
    });

    it('sees a message sent by another builder sharing the same landlet (including its own)', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-share-alice');
      const bob = await signupIdVerifiedBuilder('nearby-chat-share-bob');
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-shared' });
      await setPresence(bob.builderId, { landletId: 'nearby-chat-landlet-shared' });

      await api('/nearby-chat', alice.session({ method: 'POST', body: JSON.stringify({ text: 'hi from alice' }) }));
      const bobView = await api('/nearby-chat', bob.session());
      expect(bobView.body.messages.map((m) => m.text)).toEqual(['hi from alice']);
    });

    it('polls forward from a cursor, only returning newer messages, and echoes the same cursor back when there are none', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-cursor-alice');
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-cursor' });

      await api('/nearby-chat', alice.session({ method: 'POST', body: JSON.stringify({ text: 'first' }) }));
      const firstPoll = await api('/nearby-chat', alice.session());
      expect(firstPoll.body.messages.map((m) => m.text)).toEqual(['first']);
      const cursorAfterFirst = firstPoll.body.nextCursor;
      expect(cursorAfterFirst).toBeTruthy();

      // No new messages yet -- same cursor comes back, not null.
      const quiet = await api(`/nearby-chat?cursor=${encodeURIComponent(cursorAfterFirst)}`, alice.session());
      expect(quiet.body.messages).toEqual([]);
      expect(quiet.body.nextCursor).toBe(cursorAfterFirst);

      await api('/nearby-chat', alice.session({ method: 'POST', body: JSON.stringify({ text: 'second' }) }));
      const secondPoll = await api(`/nearby-chat?cursor=${encodeURIComponent(cursorAfterFirst)}`, alice.session());
      expect(secondPoll.body.messages.map((m) => m.text)).toEqual(['second']);
    });

    it('rejects a malformed cursor', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-bad-cursor-alice');
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-bad-cursor' });
      const rejected = await api('/nearby-chat?cursor=not-valid-base64!!', alice.session());
      expect(rejected.response.status).toBe(400);
    });

    // #2802: the response's own landletId is how the client detects a
    // landlet change and resets its cursor/log -- without this field, a
    // cursor computed against the landlet the caller just left gets
    // applied against the new landlet's messages, silently skipping any
    // of the new landlet's own already-older messages.
    it('reports the landlet the response was computed for, which changes when the caller\'s presence does', async () => {
      const alice = await signupIdVerifiedBuilder('nearby-chat-landlet-field-alice');
      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-field-a' });
      const inLandletA = await api('/nearby-chat', alice.session());
      expect(inLandletA.body.landletId).toBe('nearby-chat-landlet-field-a');

      await setPresence(alice.builderId, { landletId: 'nearby-chat-landlet-field-b' });
      const inLandletB = await api('/nearby-chat', alice.session());
      expect(inLandletB.body.landletId).toBe('nearby-chat-landlet-field-b');
    });
  });

  it('indexes nearby_chat_messages on landlet_id, covering the poll query\'s own sort', async () => {
    const indexes = (await env.DB.prepare('PRAGMA index_list(nearby_chat_messages)').all()).results;
    expect(indexes.some((idx) => idx.name === 'idx_nearby_chat_messages_landlet')).toBe(true);
  });
});
