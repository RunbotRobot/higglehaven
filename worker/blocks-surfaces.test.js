// #3143 (Blocks 2/2 of #3124): a block takes effect on every person-to-person
// surface, silently ("A block is silent"). Alice blocks Bob throughout; Bob
// must see no difference from a stranger's experience, and Alice must no
// longer see or hear him. Unblocking restores everything.
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

async function setPresence(builderId, landletId) {
  await env.DB.prepare(`
    INSERT INTO avatar_presence (builder_id, landlet_id, x, y, z, heading, flying, updated_at)
    VALUES (?, ?, 0, 0, 0, 0, 0, ?)
    ON CONFLICT (builder_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
  `).bind(builderId, landletId, new Date().toISOString()).run();
}

async function becomeFriends(a, b) {
  const sent = await api('/friendships', a.session({
    method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
  }));
  await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({
    method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
  }));
}

const block = (blocker, target) =>
  api('/blocks', blocker.session({ method: 'POST', body: JSON.stringify({ builderId: target.builderId }) }));

async function unblock(blocker, target) {
  const userId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(target.builderId).first()).user_id;
  return api(`/blocks/${userId}`, blocker.session({ method: 'DELETE' }));
}

describe('Blocks apply on every social surface (#3143)', () => {
  it('hides each side from the other in presence, both directions, and restores on unblock', async () => {
    const alice = await signupIdVerifiedBuilder('bs-pres-alice');
    const bob = await signupIdVerifiedBuilder('bs-pres-bob');
    await setPresence(alice.builderId, 'bs-pres-landlet');
    await setPresence(bob.builderId, 'bs-pres-landlet');
    const ids = async (who) => (await api('/presence', who.session())).body.avatars.map((a) => a.builderId);
    expect(await ids(alice)).toEqual([bob.builderId]);

    await block(alice, bob);
    expect(await ids(alice)).toEqual([]);
    expect(await ids(bob)).toEqual([]);

    await unblock(alice, bob);
    expect(await ids(alice)).toEqual([bob.builderId]);
    expect(await ids(bob)).toEqual([alice.builderId]);
  });

  it('hides nearby chat messages both ways while sending still works for the blocked person', async () => {
    const alice = await signupIdVerifiedBuilder('bs-chat-alice');
    const bob = await signupIdVerifiedBuilder('bs-chat-bob');
    const carol = await signupIdVerifiedBuilder('bs-chat-carol');
    for (const who of [alice, bob, carol]) await setPresence(who.builderId, 'bs-chat-landlet');
    const say = (who, text) => api('/nearby-chat', who.session({ method: 'POST', body: JSON.stringify({ text }) }));
    const texts = async (who) => (await api('/nearby-chat', who.session())).body.messages.map((m) => m.text);

    await say(alice, 'from alice');
    await say(bob, 'from bob');
    await block(alice, bob);

    expect(await texts(alice)).toEqual(['from alice']);
    expect(await texts(bob)).toEqual(['from bob']);
    // Bob can still send (same 201 a stranger gets); Carol sees everyone.
    expect((await say(bob, 'bob again')).response.status).toBe(201);
    expect(await texts(carol)).toEqual(['from alice', 'from bob', 'bob again']);
    expect(await texts(alice)).toEqual(['from alice']);

    await unblock(alice, bob);
    expect(await texts(alice)).toEqual(['from alice', 'from bob', 'bob again']);
  });

  it('accepts a voice signal across a block with 201 but never delivers it, in either direction', async () => {
    const alice = await signupIdVerifiedBuilder('bs-voice-alice');
    const bob = await signupIdVerifiedBuilder('bs-voice-bob');
    await setPresence(alice.builderId, 'bs-voice-landlet');
    await setPresence(bob.builderId, 'bs-voice-landlet');
    const signal = (from, to) => api('/voice/signal', from.session({
      method: 'POST', body: JSON.stringify({ toBuilderId: to.builderId, kind: 'offer', payload: { sdp: 'x' } }),
    }));
    const inbox = async (who) => (await api('/voice/signal', who.session())).body.messages;

    // A signal queued before the block is withheld once it exists.
    expect((await signal(bob, alice)).response.status).toBe(201);
    expect(await inbox(alice)).toHaveLength(1);
    await block(alice, bob);
    expect(await inbox(alice)).toEqual([]);

    const fromBob = await signal(bob, alice);
    expect(fromBob.response.status).toBe(201);
    expect(fromBob.body.message.kind).toBe('offer');
    const fromAlice = await signal(alice, bob);
    expect(fromAlice.response.status).toBe(201);
    expect(await inbox(alice)).toEqual([]);
    expect(await inbox(bob)).toEqual([]);
    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM voice_signaling_messages WHERE message_id = ? OR message_id = ?')
      .bind(fromBob.body.message.messageId, fromAlice.body.message.messageId).first();
    expect(stored.n).toBe(0);

    await unblock(alice, bob);
    expect((await signal(bob, alice)).response.status).toBe(201);
    // The withheld pre-block signal was only hidden, not deleted, so it
    // reappears alongside the new one.
    expect(await inbox(alice)).toHaveLength(2);
  });

  it('removes the blocked person from the blocker\'s friend voice channel, and the blocker from theirs', async () => {
    const alice = await signupIdVerifiedBuilder('bs-fvc-alice');
    const bob = await signupIdVerifiedBuilder('bs-fvc-bob');
    const dave = await signupIdVerifiedBuilder('bs-fvc-dave');
    await becomeFriends(alice, bob);
    await becomeFriends(dave, alice);
    const join = (who, owner) => api(`/voice/friend-channels/${owner.builderId}/join`, who.session({ method: 'POST' }));
    expect((await join(alice, alice)).response.status).toBeLessThan(300);
    expect((await join(bob, alice)).response.status).toBeLessThan(300);
    expect((await join(dave, dave)).response.status).toBeLessThan(300);
    expect((await join(alice, dave)).response.status).toBeLessThan(300);

    await block(alice, bob);
    const members = await env.DB.prepare('SELECT owner_builder_id, member_builder_id FROM friend_voice_channel_members WHERE member_builder_id = ? OR owner_builder_id = ?')
      .bind(bob.builderId, bob.builderId).all();
    expect(members.results).toEqual([]);

    // Blocking the owner also removes the blocker from that owner's channel.
    await block(alice, dave);
    const left = await env.DB.prepare('SELECT 1 FROM friend_voice_channel_members WHERE owner_builder_id = ? AND member_builder_id = ?')
      .bind(dave.builderId, alice.builderId).first();
    expect(left).toBeNull();
  });

  it('never surfaces a friend request to the person who blocked the sender, and cannot be accepted', async () => {
    const alice = await signupBuilder('bs-fr-alice');
    const bob = await signupBuilder('bs-fr-bob');
    await block(alice, bob);
    const notificationsBefore = (await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE builder_id = ?').bind(alice.builderId).first()).n;

    const sent = await api('/friendships', bob.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: alice.builderId }),
    }));
    // The same response a stranger gets, and Bob still sees his pending request.
    expect(sent.response.status).toBe(201);
    const bobList = await api('/friendships', bob.session());
    expect(bobList.body.friendships).toHaveLength(1);

    const aliceList = await api('/friendships', alice.session());
    expect(aliceList.body.friendships).toEqual([]);
    const notificationsAfter = (await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE builder_id = ?').bind(alice.builderId).first()).n;
    expect(notificationsAfter).toBe(notificationsBefore);
    const accept = await api(`/friendships/${sent.body.friendship.friendshipId}`, alice.session({
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    }));
    expect(accept.response.status).toBe(404);
  });

  it('keeps the blocker from friending someone they blocked, and lets a fresh request through after unblocking', async () => {
    const alice = await signupBuilder('bs-unb-alice');
    const bob = await signupBuilder('bs-unb-bob');
    await block(alice, bob);
    const request = (from, to) => api('/friendships', from.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: to.builderId }),
    }));
    expect((await request(alice, bob)).response.status).toBe(400);

    await unblock(alice, bob);
    expect((await request(bob, alice)).response.status).toBe(201);
    const list = await api('/friendships', alice.session());
    expect(list.body.friendships).toHaveLength(1);
  });

  it('treats a blocked sender\'s DM exactly like a non-friend\'s, and drops their unread count for the blocker', async () => {
    const alice = await signupIdVerifiedBuilder('bs-dm-alice');
    const bob = await signupIdVerifiedBuilder('bs-dm-bob');
    await becomeFriends(alice, bob);
    const dm = (from, to, text) => api('/direct-messages', from.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: to.builderId, text }),
    }));
    const unread = async (who) => (await api('/direct-messages/unread-count', who.session())).body.count;

    expect((await dm(bob, alice, 'hi before block')).response.status).toBe(201);
    expect(await unread(alice)).toBe(1);

    await block(alice, bob);
    expect(await unread(alice)).toBe(0);
    // History stays readable to the blocker (no silent loss of their own messages).
    const history = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(history.body.messages.map((m) => m.text)).toEqual(['hi before block']);

    // Bob gets the same plain 403 a non-friend gets, and nothing else changes for him.
    const stranger = await signupIdVerifiedBuilder('bs-dm-stranger');
    const blocked = await dm(bob, alice, 'still there?');
    const nonFriend = await dm(stranger, alice, 'hello');
    expect(blocked.response.status).toBe(403);
    expect(blocked.response.status).toBe(nonFriend.response.status);
    expect(blocked.body.error).toBe(nonFriend.body.error);
    expect(await unread(alice)).toBe(0);
  });
});
