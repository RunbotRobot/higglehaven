// #3123: suspension only gated a suspended user's own requests, so what they
// had already left in shared social surfaces stayed visible to everyone
// else: their nearby-chat messages for up to the 30-minute prune, and their
// friend voice channel memberships indefinitely. Both reads now hide a
// suspended builder; nothing is deleted, so a lifted suspension simply
// reappears.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('ssv-admin');
  adminSession = admin.session;
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

async function suspend(builder) {
  const res = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email: builder.email, reason: 'ssv test' }),
  }));
  expect(res.response.status).toBe(200);
}

async function unsuspend(builder) {
  const res = await api('/auth/unsuspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email: builder.email }),
  }));
  expect(res.response.status).toBe(200);
}

describe('a suspended account disappears from shared social surfaces (#3123)', () => {
  it('hides a suspended sender\'s nearby-chat messages from everyone else, and shows them again once lifted', async () => {
    const alice = await signupIdVerifiedBuilder('ssv-chat-alice');
    const bob = await signupIdVerifiedBuilder('ssv-chat-bob');
    await setPresence(alice.builderId, 'ssv-chat-landlet');
    await setPresence(bob.builderId, 'ssv-chat-landlet');
    const sent = await api('/nearby-chat', bob.session({ method: 'POST', body: JSON.stringify({ text: 'hello from bob' }) }));
    expect(sent.response.status).toBe(201);
    const own = await api('/nearby-chat', alice.session({ method: 'POST', body: JSON.stringify({ text: 'hello from alice' }) }));
    expect(own.response.status).toBe(201);

    const before = await api('/nearby-chat', alice.session());
    expect(before.body.messages.map((m) => m.text)).toEqual(['hello from bob', 'hello from alice']);

    await suspend(bob);
    const during = await api('/nearby-chat', alice.session());
    expect(during.body.messages.map((m) => m.text)).toEqual(['hello from alice']);

    await unsuspend(bob);
    const after = await api('/nearby-chat', alice.session());
    expect(after.body.messages.map((m) => m.text)).toEqual(['hello from bob', 'hello from alice']);
  });

  it('drops a suspended member, and a suspended owner\'s whole channel, from the friend voice channel listing', async () => {
    const owner = await signupIdVerifiedBuilder('ssv-channel-owner');
    const bob = await signupIdVerifiedBuilder('ssv-channel-bob');
    const carol = await signupIdVerifiedBuilder('ssv-channel-carol');
    await becomeFriends(owner, bob);
    await becomeFriends(owner, carol);
    for (const member of [bob, carol]) {
      const joined = await api(`/voice/friend-channels/${owner.builderId}/join`, member.session({ method: 'POST' }));
      expect(joined.response.status).toBe(201);
    }

    const membersSeenBy = async (viewer) => {
      const listed = await api('/voice/friend-channels', viewer.session());
      const channel = listed.body.channels.find((c) => c.ownerBuilderId === owner.builderId);
      return channel ? [...channel.members].sort() : null;
    };
    const everyone = [owner.builderId, bob.builderId, carol.builderId].sort();
    expect(await membersSeenBy(carol)).toEqual(everyone);

    await suspend(bob);
    expect(await membersSeenBy(carol)).toEqual([owner.builderId, carol.builderId].sort());
    await unsuspend(bob);
    expect(await membersSeenBy(carol)).toEqual(everyone);

    await suspend(owner);
    expect(await membersSeenBy(carol)).toBeNull();
    await unsuspend(owner);
    expect(await membersSeenBy(carol)).toEqual(everyone);
  });
});
