// #2781 (sub-issue of #2777, part of the proximity voice chat work --
// #2817/#2818's own signaling relay/WebRTC core): "Group voice channels
// for friends regardless of proximity" (docs/SPEC.md §2). Mirrors
// direct-messages.test.js's own becomeFriends/signupIdVerifiedBuilder
// setup, and voice-signal.test.js's own setPresence helper for the
// proximity-bypass assertions below.
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

async function becomeFriends(a, b) {
  const sent = await api('/friendships', a.session({
    method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
  }));
  await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({
    method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
  }));
  return sent.body.friendship.friendshipId;
}

async function setPresence(builderId, { landletId, updatedAt = new Date().toISOString() } = {}) {
  await env.DB.prepare(`
    INSERT INTO avatar_presence (builder_id, landlet_id, x, y, z, heading, flying, updated_at)
    VALUES (?, ?, 0, 0, 0, 0, 0, ?)
    ON CONFLICT (builder_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
  `).bind(builderId, landletId, updatedAt).run();
}

describe('Friend voice channels (#2781)', () => {
  describe('POST /voice/friend-channels/:ownerBuilderId/join', () => {
    it('requires a session', async () => {
      const anon = await api('/voice/friend-channels/some-builder/join', { method: 'POST' });
      expect(anon.response.status).toBe(401);
    });

    it('rejects a caller who is not id_verified', async () => {
      const alice = await signupBuilder('voice-channel-join-unverified-alice');
      const rejected = await api(`/voice/friend-channels/${alice.builderId}/join`, alice.session({ method: 'POST' }));
      expect(rejected.response.status).toBe(403);
      // #2954: requireIdVerifiedSessionBuilder used to hardcode direct
      // messages' own error text for every caller, including this one.
      expect(rejected.body.error).toBe('ID verification is required to use voice chat.');
    });

    it('lets a builder start (join) their own channel with no friendship required', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-self-join-alice');
      const joined = await api(`/voice/friend-channels/${alice.builderId}/join`, alice.session({ method: 'POST' }));
      expect(joined.response.status).toBe(201);
      const listed = await api('/voice/friend-channels', alice.session());
      expect(listed.body.channels).toEqual([{ ownerBuilderId: alice.builderId, members: [alice.builderId] }]);
    });

    it('rejects joining a channel owned by someone who is not an accepted friend', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-join-nonfriend-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-join-nonfriend-bob');
      const rejected = await api(`/voice/friend-channels/${bob.builderId}/join`, alice.session({ method: 'POST' }));
      expect(rejected.response.status).toBe(403);
    });

    it('rejects joining when only a pending (not yet accepted) friend request exists', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-join-pending-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-join-pending-bob');
      await api('/friendships', alice.session({
        method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId }),
      }));
      const rejected = await api(`/voice/friend-channels/${bob.builderId}/join`, alice.session({ method: 'POST' }));
      expect(rejected.response.status).toBe(403);
    });

    it('lets an accepted friend join, which also opens the owner\'s channel', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-join-friend-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-join-friend-bob');
      await becomeFriends(alice, bob);

      const joined = await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      expect(joined.response.status).toBe(201);

      // The owner (alice) is now also a member -- joining anyone's channel
      // opens it, no separate "start" action required of the owner.
      const aliceView = await api('/voice/friend-channels', alice.session());
      expect(aliceView.body.channels).toEqual([
        { ownerBuilderId: alice.builderId, members: expect.arrayContaining([alice.builderId, bob.builderId]) },
      ]);
      expect(aliceView.body.channels[0].members).toHaveLength(2);

      const bobView = await api('/voice/friend-channels', bob.session());
      expect(bobView.body.channels).toEqual(aliceView.body.channels);
    });

    it('is idempotent -- joining twice does not duplicate membership or error', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-join-twice-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-join-twice-bob');
      await becomeFriends(alice, bob);

      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      const again = await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      expect(again.response.status).toBe(201);

      const view = await api('/voice/friend-channels', alice.session());
      expect(view.body.channels[0].members).toHaveLength(2);
    });

    // #2833 (split out of #2781): the owner has no other way to learn their
    // channel just went active -- mirrors direct-messages.test.js's own
    // "fires a notification" assertion above.
    it('notifies the owner once their channel activates for the first time', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-notify-activate-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-notify-activate-bob');
      await becomeFriends(alice, bob);

      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      const aliceNotices = await api('/notifications', alice.session());
      expect(aliceNotices.body.notifications.some(
        (n) => n.message === 'voice-channel-notify-activate-bob is waiting in your voice channel.')).toBe(true);
    });

    it('does not notify the owner again when a second friend joins an already-active channel', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-notify-noduplicate-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-notify-noduplicate-bob');
      const carol = await signupIdVerifiedBuilder('voice-channel-notify-noduplicate-carol');
      await becomeFriends(alice, bob);
      await becomeFriends(alice, carol);

      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      await api(`/voice/friend-channels/${alice.builderId}/join`, carol.session({ method: 'POST' }));

      const aliceNotices = await api('/notifications', alice.session());
      const activationNotices = aliceNotices.body.notifications.filter((n) => n.message.endsWith('is waiting in your voice channel.'));
      expect(activationNotices).toHaveLength(1);
      expect(activationNotices[0].message).toBe('voice-channel-notify-noduplicate-bob is waiting in your voice channel.');
    });

    // #2930: fired together, not awaited one at a time -- a separate
    // pre-check SELECT (the previous shape here) could let both requests
    // read "not yet active" before either's INSERT committed, double-firing
    // this notification. Same race shape as reviews-auth.test.js's own
    // "#200, same race shape as #259's friendships fix" comment.
    it('notifies the owner only once when two friends join concurrently', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-notify-concurrent-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-notify-concurrent-bob');
      const carol = await signupIdVerifiedBuilder('voice-channel-notify-concurrent-carol');
      await becomeFriends(alice, bob);
      await becomeFriends(alice, carol);

      const [first, second] = await Promise.all([
        api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' })),
        api(`/voice/friend-channels/${alice.builderId}/join`, carol.session({ method: 'POST' })),
      ]);
      expect([first.response.status, second.response.status]).toEqual([201, 201]);

      const aliceNotices = await api('/notifications', alice.session());
      const activationNotices = aliceNotices.body.notifications.filter((n) => n.message.endsWith('is waiting in your voice channel.'));
      expect(activationNotices).toHaveLength(1);

      const view = await api('/voice/friend-channels', alice.session());
      expect(view.body.channels[0].members.sort()).toEqual([alice.builderId, bob.builderId, carol.builderId].sort());
    });

    it('does not notify a builder who starts (joins) their own channel', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-notify-selfjoin-alice');
      await api(`/voice/friend-channels/${alice.builderId}/join`, alice.session({ method: 'POST' }));

      const aliceNotices = await api('/notifications', alice.session());
      expect(aliceNotices.body.notifications.some((n) => n.message.endsWith('is waiting in your voice channel.'))).toBe(false);
    });

    it('notifies the owner again on a fresh activation after the channel was closed', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-notify-reactivate-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-notify-reactivate-bob');
      await becomeFriends(alice, bob);

      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      await api(`/voice/friend-channels/${alice.builderId}/leave`, alice.session({ method: 'POST' }));
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      const aliceNotices = await api('/notifications', alice.session());
      const activationNotices = aliceNotices.body.notifications.filter((n) => n.message.endsWith('is waiting in your voice channel.'));
      expect(activationNotices).toHaveLength(2);
    });

    it('lets a third accepted friend join the same channel -- membership is not pairwise-only', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-group-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-group-bob');
      const carol = await signupIdVerifiedBuilder('voice-channel-group-carol');
      await becomeFriends(alice, bob);
      await becomeFriends(alice, carol);

      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      await api(`/voice/friend-channels/${alice.builderId}/join`, carol.session({ method: 'POST' }));

      const view = await api('/voice/friend-channels', alice.session());
      expect(view.body.channels).toHaveLength(1);
      expect(view.body.channels[0].members.sort()).toEqual([alice.builderId, bob.builderId, carol.builderId].sort());
    });
  });

  describe('POST /voice/friend-channels/:ownerBuilderId/leave', () => {
    it('requires a session', async () => {
      const anon = await api('/voice/friend-channels/some-builder/leave', { method: 'POST' });
      expect(anon.response.status).toBe(401);
    });

    it('removes only the caller when a non-owner member leaves', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-leave-member-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-leave-member-bob');
      await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      const left = await api(`/voice/friend-channels/${alice.builderId}/leave`, bob.session({ method: 'POST' }));
      expect(left.response.status).toBe(200);

      const aliceView = await api('/voice/friend-channels', alice.session());
      expect(aliceView.body.channels).toEqual([{ ownerBuilderId: alice.builderId, members: [alice.builderId] }]);

      const bobView = await api('/voice/friend-channels', bob.session());
      expect(bobView.body.channels).toEqual([]);
    });

    it('closes the channel for everyone when the owner leaves', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-leave-owner-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-leave-owner-bob');
      await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      const left = await api(`/voice/friend-channels/${alice.builderId}/leave`, alice.session({ method: 'POST' }));
      expect(left.response.status).toBe(200);

      const aliceView = await api('/voice/friend-channels', alice.session());
      expect(aliceView.body.channels).toEqual([]);
      const bobView = await api('/voice/friend-channels', bob.session());
      expect(bobView.body.channels).toEqual([]);
    });

    it('is a quiet no-op when leaving a channel never joined', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-leave-noop-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-leave-noop-bob');
      const left = await api(`/voice/friend-channels/${bob.builderId}/leave`, alice.session({ method: 'POST' }));
      expect(left.response.status).toBe(200);
    });
  });

  // #2838: a channel membership was only ever checked against the
  // friendship at join time (assertAcceptedFriendship above), never again
  // afterward -- unfriending left a stale membership row behind with no
  // way for the channel's owner to remove it themselves.
  describe('unfriending a channel member (#2838)', () => {
    it('removes the stale membership when the owner unfriends a joined member', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-unfriend-owner-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-unfriend-owner-bob');
      const friendshipId = await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      const unfriended = await api(`/friendships/${friendshipId}`, alice.session({ method: 'DELETE' }));
      expect(unfriended.response.status).toBe(200);

      const aliceView = await api('/voice/friend-channels', alice.session());
      expect(aliceView.body.channels).toEqual([{ ownerBuilderId: alice.builderId, members: [alice.builderId] }]);
      const bobView = await api('/voice/friend-channels', bob.session());
      expect(bobView.body.channels).toEqual([]);
    });

    it('removes the stale membership when a member unfriends the channel owner', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-unfriend-member-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-unfriend-member-bob');
      const friendshipId = await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      const unfriended = await api(`/friendships/${friendshipId}`, bob.session({ method: 'DELETE' }));
      expect(unfriended.response.status).toBe(200);

      const bobView = await api('/voice/friend-channels', bob.session());
      expect(bobView.body.channels).toEqual([]);
    });

    it('does not affect an unrelated accepted friend\'s own membership in the same channel', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-unfriend-unrelated-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-unfriend-unrelated-bob');
      const carol = await signupIdVerifiedBuilder('voice-channel-unfriend-unrelated-carol');
      const bobFriendshipId = await becomeFriends(alice, bob);
      await becomeFriends(alice, carol);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      await api(`/voice/friend-channels/${alice.builderId}/join`, carol.session({ method: 'POST' }));

      await api(`/friendships/${bobFriendshipId}`, alice.session({ method: 'DELETE' }));

      const aliceView = await api('/voice/friend-channels', alice.session());
      expect(aliceView.body.channels).toHaveLength(1);
      expect(aliceView.body.channels[0].members.sort()).toEqual([alice.builderId, carol.builderId].sort());
    });
  });

  describe('GET /voice/friend-channels', () => {
    it('requires a session', async () => {
      const anon = await api('/voice/friend-channels');
      expect(anon.response.status).toBe(401);
    });

    it('returns an empty list for a builder in no channel', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-list-empty-alice');
      const got = await api('/voice/friend-channels', alice.session());
      expect(got.response.status).toBe(200);
      expect(got.body.channels).toEqual([]);
    });
  });

  // #2781's core authorization change: POST /voice/signal's own proximity
  // check (voice-signal.test.js) can be bypassed by naming an active,
  // shared friend channel instead.
  describe('POST /voice/signal with channelOwnerBuilderId', () => {
    it('relays a signal between two friend-channel members in different landlets', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-signal-diff-landlet-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-signal-diff-landlet-bob');
      await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      await setPresence(alice.builderId, { landletId: 'voice-channel-landlet-a' });
      await setPresence(bob.builderId, { landletId: 'voice-channel-landlet-b' });

      // Without channelOwnerBuilderId, the ordinary proximity check still
      // rejects this (different landlets) -- confirms the bypass below is
      // actually doing something, not just always-permissive.
      const withoutChannel = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' } }),
      }));
      expect(withoutChannel.response.status).toBe(400);

      const sent = await api('/voice/signal', alice.session({
        method: 'POST',
        body: JSON.stringify({
          toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'channel-offer' }, channelOwnerBuilderId: alice.builderId,
        }),
      }));
      expect(sent.response.status).toBe(201);
      expect(sent.body.message).toMatchObject({ channelOwnerBuilderId: alice.builderId, payload: { sdp: 'channel-offer' } });

      // Bob (in a different landlet than alice) still receives it -- the
      // GET poll's own landlet match is bypassed too for a channel-tagged
      // row.
      const bobView = await api('/voice/signal', bob.session());
      expect(bobView.body.messages).toHaveLength(1);
      expect(bobView.body.messages[0]).toMatchObject({ channelOwnerBuilderId: alice.builderId, fromBuilderId: alice.builderId });
    });

    it('rejects a channel signal to someone who is not a member of that channel', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-signal-nonmember-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-signal-nonmember-bob');
      const carol = await signupIdVerifiedBuilder('voice-channel-signal-nonmember-carol');
      await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      await setPresence(alice.builderId, { landletId: 'voice-channel-landlet-nonmember' });

      const rejected = await api('/voice/signal', alice.session({
        method: 'POST',
        body: JSON.stringify({
          toBuilderId: carol.builderId, kind: 'offer', payload: { sdp: 'x' }, channelOwnerBuilderId: alice.builderId,
        }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects a channel signal naming a channel that was never opened', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-signal-neveropened-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-signal-neveropened-bob');
      await setPresence(alice.builderId, { landletId: 'voice-channel-landlet-neveropened' });

      const rejected = await api('/voice/signal', alice.session({
        method: 'POST',
        body: JSON.stringify({
          toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' }, channelOwnerBuilderId: alice.builderId,
        }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('still requires the sender to have a recent presence row even for a channel signal', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-signal-nopresence-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-signal-nopresence-bob');
      await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      const rejected = await api('/voice/signal', alice.session({
        method: 'POST',
        body: JSON.stringify({
          toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' }, channelOwnerBuilderId: alice.builderId,
        }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('a plain proximity signal (no channelOwnerBuilderId) carries a null channelOwnerBuilderId', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-signal-plain-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-signal-plain-bob');
      await setPresence(alice.builderId, { landletId: 'voice-channel-landlet-plain' });
      await setPresence(bob.builderId, { landletId: 'voice-channel-landlet-plain' });

      const sent = await api('/voice/signal', alice.session({
        method: 'POST', body: JSON.stringify({ toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' } }),
      }));
      expect(sent.response.status).toBe(201);
      expect(sent.body.message.channelOwnerBuilderId).toBeNull();
    });

    it('a friend leaving the channel can no longer be signaled under it', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-signal-afterleave-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-signal-afterleave-bob');
      await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));
      await setPresence(alice.builderId, { landletId: 'voice-channel-landlet-afterleave' });

      await api(`/voice/friend-channels/${alice.builderId}/leave`, bob.session({ method: 'POST' }));

      const rejected = await api('/voice/signal', alice.session({
        method: 'POST',
        body: JSON.stringify({
          toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'x' }, channelOwnerBuilderId: alice.builderId,
        }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    // #2897: "regardless of proximity" has to mean regardless of the
    // *recipient's* own live position too, not just the sender's --
    // src/shop/voiceChat.js's own friend-channel poll deliberately keeps
    // running outside Shop mode's render tick specifically so a call can
    // survive the recipient leaving Shop mode mid-conversation, but their
    // avatar_presence row (only ever written by Shop-mode-specific code)
    // still goes stale 10s after that. The GET poll must keep delivering a
    // channel-tagged signal regardless, even once the recipient's own
    // landlet lookup comes back null.
    it('still delivers a pending channel signal once the recipient\'s own presence has gone stale', async () => {
      const alice = await signupIdVerifiedBuilder('voice-channel-signal-stale-alice');
      const bob = await signupIdVerifiedBuilder('voice-channel-signal-stale-bob');
      await becomeFriends(alice, bob);
      await api(`/voice/friend-channels/${alice.builderId}/join`, bob.session({ method: 'POST' }));

      await setPresence(alice.builderId, { landletId: 'voice-channel-landlet-stale-a' });
      await setPresence(bob.builderId, { landletId: 'voice-channel-landlet-stale-b' });

      const sent = await api('/voice/signal', alice.session({
        method: 'POST',
        body: JSON.stringify({
          toBuilderId: bob.builderId, kind: 'offer', payload: { sdp: 'channel-offer' }, channelOwnerBuilderId: alice.builderId,
        }),
      }));
      expect(sent.response.status).toBe(201);

      // Bob leaves Shop mode (e.g. opens Build mode) for longer than
      // PRESENCE_STALE_AFTER_MS while still on the call.
      await setPresence(bob.builderId, {
        landletId: 'voice-channel-landlet-stale-b',
        updatedAt: new Date(Date.now() - 15000).toISOString(),
      });

      const bobView = await api('/voice/signal', bob.session());
      expect(bobView.body.landletId).toBeNull();
      expect(bobView.body.messages).toHaveLength(1);
      expect(bobView.body.messages[0]).toMatchObject({ channelOwnerBuilderId: alice.builderId, fromBuilderId: alice.builderId });
    });
  });
});
