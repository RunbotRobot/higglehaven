// #2817 (sub-issue of #2780, itself sub-issue of #2777, proximity voice
// chat): GET/POST /voice/signal. Mirrors nearby-chat.test.js's own
// signupIdVerifiedBuilder/setPresence helpers (the id_verified bar and
// landlet-derivation anti-spoof pattern, #2269, this endpoint reuses
// verbatim via callersCurrentLandletId in worker/lib/social.js) --
// the key difference under test here is that this relay is point-to-point
// (addressed to one specific toBuilderId), not a landlet-wide broadcast.
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

describe('Voice signaling relay (#2817)', () => {
  describe('POST /voice/signal', () => {
    it('requires a session', async () => {
      const anon = await api('/voice/signal', {
        method: 'POST', body: JSON.stringify({ toBuilderId: 'x', kind: 'offer', payload: { sdp: 'x' } }),
      });
      expect(anon.response.status).toBe(401);
    });

    it('rejects a sender who is not id_verified', async () => {
      const alice = await signupBuilder('voice-signal-unverified-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-unverified-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-1' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-1' });
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' } }),
      }));
      expect(rejected.response.status).toBe(403);
      expect(rejected.body.idVerificationRequired).toBe(true);
    });

    it('rejects a sender with no recent presence row', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-no-presence-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-no-presence-bob');
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' } }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects signaling to a recipient in a different landlet', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-diff-landlet-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-diff-landlet-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-a' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-b' });
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' } }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects signaling to a recipient with no presence row at all', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-no-recipient-alice');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-no-recipient' });
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: 'nonexistent-builder', kind: 'offer', payload: { sdp: 'x' } }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects signaling to oneself', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-self-alice');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-self' });
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: alice.builderId, kind: 'offer', payload: { sdp: 'x' } }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects an unrecognized kind', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-badkind-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-badkind-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-badkind' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-badkind' });
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'bogus', payload: { sdp: 'x' } }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects a missing payload', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-nopayload-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-nopayload-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-nopayload' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-nopayload' });
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer' }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects an oversized payload', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-oversized-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-oversized-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-oversized' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-oversized' });
      const rejected = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x'.repeat(20000) } }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('relays an offer from one builder to another sharing the same landlet', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-send-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-send-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-send' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-send' });

      const sent = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'offer-sdp' } }),
      }));
      expect(sent.response.status).toBe(201);
      expect(sent.body.message).toMatchObject({
        fromBuilderId: alice.builderId, kind: 'offer', payload: { sdp: 'offer-sdp' },
      });
      expect(sent.body.message.messageId).toBeTruthy();
      expect(sent.body.message.createdAt).toBeTruthy();
    });
  });

  describe('GET /voice/signal', () => {
    it('requires a session', async () => {
      const anon = await api('/voice/signal');
      expect(anon.response.status).toBe(401);
    });

    it('rejects a poller who is not id_verified', async () => {
      const alice = await signupBuilder('voice-signal-poll-unverified-alice');
      const rejected = await api('/voice/signal', alice.session());
      expect(rejected.response.status).toBe(403);
    });

    it('returns an empty list with a null cursor and null landletId when the caller has no recent presence row', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-poll-no-presence-alice');
      const got = await api('/voice/signal', alice.session());
      expect(got.response.status).toBe(200);
      expect(got.body).toEqual({ messages: [], nextCursor: null, landletId: null });
    });

    it('only returns messages addressed to the caller, not messages addressed to someone else in the same landlet', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-scope-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-scope-bob');
      const carol = await signupIdVerifiedBuilder('voice-signal-scope-carol');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-scope' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-scope' });
      await setPresence(carol.builderId, { landletId: 'voice-signal-landlet-scope' });

      await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'to-bob' } }),
      }));
      await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: carol.builderId, kind: 'offer', payload: { sdp: 'to-carol' } }),
      }));

      const bobView = await api('/voice/signal', bob.session());
      expect(bobView.body.messages).toHaveLength(1);
      expect(bobView.body.messages[0].payload).toEqual({ sdp: 'to-bob' });

      const carolView = await api('/voice/signal', carol.session());
      expect(carolView.body.messages).toHaveLength(1);
      expect(carolView.body.messages[0].payload).toEqual({ sdp: 'to-carol' });
    });

    it('does not return a message addressed to the caller from a different landlet than they currently stand in', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-landletmove-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-landletmove-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-move-a' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-move-a' });
      await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' } }),
      }));

      // Bob moves to a different landlet before polling.
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-move-b' });
      const bobView = await api('/voice/signal', bob.session());
      expect(bobView.body.messages).toEqual([]);
      expect(bobView.body.landletId).toBe('voice-signal-landlet-move-b');
    });

    it('polls forward from a cursor, only returning newer messages, and echoes the same cursor back when there are none', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-cursor-alice');
      const bob = await signupIdVerifiedBuilder('voice-signal-cursor-bob');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-cursor' });
      await setPresence(bob.builderId, { landletId: 'voice-signal-landlet-cursor' });

      await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'first' } }),
      }));
      const firstPoll = await api('/voice/signal', bob.session());
      expect(firstPoll.body.messages.map((m) => m.payload.sdp)).toEqual(['first']);
      const cursorAfterFirst = firstPoll.body.nextCursor;
      expect(cursorAfterFirst).toBeTruthy();

      const quiet = await api(`/voice/signal?cursor=${encodeURIComponent(cursorAfterFirst)}`, bob.session());
      expect(quiet.body.messages).toEqual([]);
      expect(quiet.body.nextCursor).toBe(cursorAfterFirst);

      await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'ice-candidate', payload: { sdp: 'second' } }),
      }));
      const secondPoll = await api(`/voice/signal?cursor=${encodeURIComponent(cursorAfterFirst)}`, bob.session());
      expect(secondPoll.body.messages.map((m) => m.payload.sdp)).toEqual(['second']);
    });

    it('rejects a malformed cursor', async () => {
      const alice = await signupIdVerifiedBuilder('voice-signal-bad-cursor-alice');
      await setPresence(alice.builderId, { landletId: 'voice-signal-landlet-bad-cursor' });
      const rejected = await api('/voice/signal?cursor=not-valid-base64!!', alice.session());
      expect(rejected.response.status).toBe(400);
    });
  });

  it('indexes voice_signaling_messages on (to_builder_id, landlet_id), covering the poll query\'s own sort', async () => {
    const indexes = (await env.DB.prepare('PRAGMA index_list(voice_signaling_messages)').all()).results;
    expect(indexes.some((idx) => idx.name === 'idx_voice_signaling_messages_recipient')).toBe(true);
  });

  // #2818: ICE server config -- STUN always, TURN only once the owner's
  // self-hosted relay secret is actually configured.
  describe('GET /voice/ice-config', () => {
    afterEach(() => {
      env.TURN_SERVER_URL = undefined;
      env.TURN_SERVER_USERNAME = undefined;
      env.TURN_SERVER_CREDENTIAL = undefined;
    });

    it('requires a session', async () => {
      const anon = await api('/voice/ice-config');
      expect(anon.response.status).toBe(401);
    });

    it('rejects a caller who is not id_verified', async () => {
      const alice = await signupBuilder('voice-ice-config-unverified-alice');
      const rejected = await api('/voice/ice-config', alice.session());
      expect(rejected.response.status).toBe(403);
    });

    it('returns STUN only when no TURN secret is configured', async () => {
      const alice = await signupIdVerifiedBuilder('voice-ice-config-stun-only-alice');
      const got = await api('/voice/ice-config', alice.session());
      expect(got.response.status).toBe(200);
      expect(got.body.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    });

    it('includes the TURN server once its secret is configured', async () => {
      env.TURN_SERVER_URL = 'turn:turn.example.com:3478';
      env.TURN_SERVER_USERNAME = 'test-turn-user';
      env.TURN_SERVER_CREDENTIAL = 'test-turn-credential';
      const alice = await signupIdVerifiedBuilder('voice-ice-config-turn-alice');
      const got = await api('/voice/ice-config', alice.session());
      expect(got.response.status).toBe(200);
      expect(got.body.iceServers).toEqual([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:turn.example.com:3478', username: 'test-turn-user', credential: 'test-turn-credential' },
      ]);
    });
  });
});
