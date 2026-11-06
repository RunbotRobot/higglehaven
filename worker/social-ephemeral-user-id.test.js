// #3147 (4/6 of #3141): presence, nearby chat, voice signaling and friend voice
// channel membership are stored against the account (users.user_id), not the
// resettable builder profile (migrations/0194). The wire still names people by
// their CURRENT builder id and adds the stable user ids.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Every signup*() helper in test-helpers.js uses this same fixed password.
const TEST_PASSWORD = 'a fine long password here';

// Every person carries their account's user id from signup: after a profile
// reset their old builder id no longer resolves, but the account does not change.
async function signupAccount(label) {
  const builder = await signupBuilder(label);
  const userId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(builder.builderId).first()).user_id;
  return { ...builder, userId };
}

async function signupIdVerifiedBuilder(label) {
  const person = await signupAccount(label);
  await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE user_id = ?").bind(person.userId).run();
  return person;
}

async function userIdOf(person) {
  return person.userId;
}

async function becomeFriends(a, b) {
  const sent = await api('/friendships', a.session({
    method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
  }));
  await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({
    method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
  }));
}

// Same "insert the state a real write would have produced" shortcut the other
// presence-dependent suites use; keyed on the account like the real writer.
async function setPresence(person, landletId) {
  await env.DB.prepare(`
    INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
    VALUES (?, ?, 0, 0, 0, 0, 0, ?)
    ON CONFLICT (user_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
  `).bind(await userIdOf(person), landletId, new Date().toISOString()).run();
}

// Resetting a builder profile is DELETE /api/builders/:id. Until the next
// session call there is no builder for the account; the call after creates a
// brand-new one. Returns the person with their new builder id.
async function resetBuilderProfile(person, { recreate = true } = {}) {
  const deleted = await api(`/builders/${person.builderId}`, person.session({ method: 'DELETE' }));
  expect(deleted.response.status).toBe(200);
  if (!recreate) return person;
  const fresh = await api('/builders/me', person.session());
  expect(fresh.body.builder.builderId).not.toBe(person.builderId);
  return { ...person, builderId: fresh.body.builder.builderId };
}

const nearby = (viewer) => api('/presence', viewer.session()).then((r) => r.body.avatars);
const chatLog = (viewer) => api('/nearby-chat', viewer.session()).then((r) => r.body.messages);
const sendSignal = (from, to, extra = {}) => api('/voice/signal', from.session({
  method: 'POST', body: JSON.stringify({ toBuilderId: to.builderId, kind: 'offer', payload: { sdp: 'x' }, ...extra }),
}));
const inbox = (who) => api('/voice/signal', who.session()).then((r) => r.body.messages);
const channels = (who) => api('/voice/friend-channels', who.session()).then((r) => r.body.channels);
const join = (who, owner) => api(`/voice/friend-channels/${owner.builderId}/join`, who.session({ method: 'POST' }));

describe('Presence keyed on the account (#3147)', () => {
  it('stores the user id, and a profile reset neither deletes the position nor breaks the wire', async () => {
    const alice = await signupAccount('eph-presence-alice');
    const bob = await signupAccount('eph-presence-bob');
    await setPresence(alice, 'eph-landlet-presence');
    await setPresence(bob, 'eph-landlet-presence');

    const before = await nearby(bob);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ builderId: alice.builderId, userId: await userIdOf(alice) });

    await resetBuilderProfile(alice, { recreate: false });
    // The position row is the person's, so it survives the reset...
    const survived = await env.DB.prepare('SELECT * FROM avatar_presence WHERE user_id = ?').bind(await userIdOf(alice)).first();
    expect(survived).not.toBeNull();
    // ...but with no builder profile right now there is nothing to render.
    expect(await nearby(bob)).toEqual([]);

    const fresh = (await api('/builders/me', alice.session())).body.builder;
    const after = await nearby(bob);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ builderId: fresh.builderId, userId: await userIdOf(alice) });
    expect(fresh.builderId).not.toBe(alice.builderId);
  });

  it('bills the report quota to the account', async () => {
    const alice = await signupAccount('eph-presence-quota');
    await api('/presence', alice.session({ method: 'POST', body: JSON.stringify({ x: 1, y: 2, z: 3 }) }));
    const userId = await userIdOf(alice);
    const counted = await env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limit_events WHERE bucket_key = ?').bind(`presence-report:${userId}`).first();
    expect(counted.c).toBe(1);
    const oldKey = await env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limit_events WHERE bucket_key = ?').bind(`presence-report:${alice.builderId}`).first();
    expect(oldKey.c).toBe(0);
  });
});

describe('Nearby chat keyed on the account (#3147)', () => {
  it('keeps a message after its author resets their profile, attributed to their current builder id', async () => {
    const alice = await signupIdVerifiedBuilder('eph-chat-alice');
    const bob = await signupIdVerifiedBuilder('eph-chat-bob');
    await setPresence(alice, 'eph-landlet-chat');
    await setPresence(bob, 'eph-landlet-chat');
    const posted = await api('/nearby-chat', alice.session({ method: 'POST', body: JSON.stringify({ text: 'hello there' }) }));
    expect(posted.response.status).toBe(201);
    expect(posted.body.message).toMatchObject({ builderId: alice.builderId, userId: await userIdOf(alice) });

    expect((await chatLog(bob)).map((m) => m.text)).toEqual(['hello there']);

    await resetBuilderProfile(alice, { recreate: false });
    // No builder profile to attribute the line to right now.
    expect(await chatLog(bob)).toEqual([]);
    const fresh = (await api('/builders/me', alice.session())).body.builder;
    const log = await chatLog(bob);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ text: 'hello there', builderId: fresh.builderId, userId: await userIdOf(alice) });
  });

  it('bills the send quota to the account', async () => {
    const alice = await signupIdVerifiedBuilder('eph-chat-quota');
    await setPresence(alice, 'eph-landlet-chat-quota');
    await api('/nearby-chat', alice.session({ method: 'POST', body: JSON.stringify({ text: 'x' }) }));
    const counted = await env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limit_events WHERE bucket_key = ?').bind(`nearby-chat-send:${await userIdOf(alice)}`).first();
    expect(counted.c).toBe(1);
  });
});

describe('Voice signaling keyed on the account (#3147)', () => {
  it('stores user ids and returns both ids on the wire', async () => {
    const alice = await signupIdVerifiedBuilder('eph-signal-store-alice');
    const bob = await signupIdVerifiedBuilder('eph-signal-store-bob');
    await setPresence(alice, 'eph-landlet-signal-store');
    await setPresence(bob, 'eph-landlet-signal-store');
    const sent = await sendSignal(alice, bob);
    expect(sent.response.status).toBe(201);
    expect(sent.body.message).toMatchObject({ fromBuilderId: alice.builderId, fromUserId: await userIdOf(alice) });
    const row = await env.DB.prepare('SELECT * FROM voice_signaling_messages WHERE message_id = ?').bind(sent.body.message.messageId).first();
    expect(row.from_user_id).toBe(await userIdOf(alice));
    expect(row.to_user_id).toBe(await userIdOf(bob));
    const received = await inbox(bob);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ fromBuilderId: alice.builderId, fromUserId: await userIdOf(alice) });
  });

  it('still delivers a signal after the RECIPIENT resets, and addresses them by their new builder id from then on', async () => {
    const alice = await signupIdVerifiedBuilder('eph-signal-recv-alice');
    const bob = await signupIdVerifiedBuilder('eph-signal-recv-bob');
    await setPresence(alice, 'eph-landlet-signal-recv');
    await setPresence(bob, 'eph-landlet-signal-recv');
    await sendSignal(alice, bob);

    const bobNow = await resetBuilderProfile(bob);
    // The old builder id no longer names anyone: refused like any stranger.
    const stale = await sendSignal(alice, bob);
    expect(stale.response.status).toBe(400);
    expect(stale.body.error).toMatch(/not currently in your landlet/);
    // The new one works, with Bob's presence (the account's) intact.
    const fresh = await sendSignal(alice, bobNow);
    expect(fresh.response.status).toBe(201);
    expect(await inbox(bobNow)).toHaveLength(2);
  });

  it('attributes a signal to the SENDER\'s current builder id after they reset', async () => {
    const alice = await signupIdVerifiedBuilder('eph-signal-send-alice');
    const bob = await signupIdVerifiedBuilder('eph-signal-send-bob');
    await setPresence(alice, 'eph-landlet-signal-send');
    await setPresence(bob, 'eph-landlet-signal-send');
    await sendSignal(alice, bob);
    const aliceNow = await resetBuilderProfile(alice);
    const received = await inbox(bob);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ fromBuilderId: aliceNow.builderId, fromUserId: await userIdOf(alice) });
  });

  it('bills the send quota to the account', async () => {
    const alice = await signupIdVerifiedBuilder('eph-signal-quota-alice');
    const bob = await signupIdVerifiedBuilder('eph-signal-quota-bob');
    await setPresence(alice, 'eph-landlet-signal-quota');
    await setPresence(bob, 'eph-landlet-signal-quota');
    await sendSignal(alice, bob);
    const counted = await env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limit_events WHERE bucket_key = ?').bind(`voice-signal-send:${await userIdOf(alice)}`).first();
    expect(counted.c).toBe(1);
  });
});

describe('Friend voice channels keyed on the account (#3147)', () => {
  it('keeps the channel and its members when the OWNER resets their profile, under the owner\'s new builder id', async () => {
    const alice = await signupIdVerifiedBuilder('eph-channel-alice');
    const bob = await signupIdVerifiedBuilder('eph-channel-bob');
    await becomeFriends(alice, bob);
    expect((await join(alice, alice)).response.status).toBeLessThan(300);
    expect((await join(bob, alice)).response.status).toBeLessThan(300);

    const aliceNow = await resetBuilderProfile(alice);
    const listed = await channels(bob);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ ownerBuilderId: aliceNow.builderId, ownerUserId: await userIdOf(alice) });
    expect(listed[0].members.sort()).toEqual([aliceNow.builderId, bob.builderId].sort());
    // Bob can still leave it by the owner's current id, and the old id is a stranger.
    expect((await join(bob, alice)).response.status).toBe(403);
    expect((await api(`/voice/friend-channels/${aliceNow.builderId}/leave`, bob.session({ method: 'POST' }))).response.status).toBe(200);
    expect(await channels(bob)).toEqual([]);
  });

  it('keeps a member when they reset their profile, listed by their new builder id', async () => {
    const alice = await signupIdVerifiedBuilder('eph-channel-member-alice');
    const bob = await signupIdVerifiedBuilder('eph-channel-member-bob');
    await becomeFriends(alice, bob);
    await join(alice, alice);
    await join(bob, alice);
    const bobNow = await resetBuilderProfile(bob);
    const listed = await channels(alice);
    expect(listed[0].members.sort()).toEqual([alice.builderId, bobNow.builderId].sort());
    expect(listed[0].memberUserIds).toContain(await userIdOf(bob));
  });

  it('hides a blocked person from the listing even if a stale membership row survived (both directions)', async () => {
    const alice = await signupIdVerifiedBuilder('eph-channel-block-alice');
    const bob = await signupIdVerifiedBuilder('eph-channel-block-bob');
    await becomeFriends(alice, bob);
    await join(alice, alice);
    await join(bob, alice);
    expect(await channels(alice)).toHaveLength(1);
    // Simulate a row that predates the block (the API severs it on block).
    await env.DB.prepare('INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES (?, ?)')
      .bind(await userIdOf(alice), await userIdOf(bob)).run();
    // The blocker still has their own channel, minus the blocked member; the
    // blocked person no longer sees the blocker's channel at all.
    const blockerView = await channels(alice);
    expect(blockerView).toHaveLength(1);
    expect(blockerView[0].members).toEqual([alice.builderId]);
    expect(await channels(bob)).toEqual([]);
    await env.DB.prepare('DELETE FROM user_blocks WHERE blocker_user_id = ?').bind(await userIdOf(alice)).run();
    expect((await channels(alice))[0].members.sort()).toEqual([alice.builderId, bob.builderId].sort());
    expect(await channels(bob)).toHaveLength(1);
  });

  it('bills the join quota to the account', async () => {
    const alice = await signupIdVerifiedBuilder('eph-channel-quota');
    await join(alice, alice);
    const counted = await env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limit_events WHERE bucket_key = ?').bind(`friend-voice-channel-mutate:${await userIdOf(alice)}`).first();
    expect(counted.c).toBe(1);
  });
});

describe('Account deletion removes the account\'s ephemeral social rows (#3147)', () => {
  it('deletes presence, chat, signals (sent and received) and channel rows, and leaves other people\'s alone', async () => {
    const victim = await signupIdVerifiedBuilder('eph-delete-victim');
    const friend = await signupIdVerifiedBuilder('eph-delete-friend');
    await becomeFriends(victim, friend);
    await setPresence(victim, 'eph-landlet-delete');
    await setPresence(friend, 'eph-landlet-delete');
    await api('/nearby-chat', victim.session({ method: 'POST', body: JSON.stringify({ text: 'bye' }) }));
    await api('/nearby-chat', friend.session({ method: 'POST', body: JSON.stringify({ text: 'still here' }) }));
    await sendSignal(victim, friend);
    await sendSignal(friend, victim);
    await join(victim, victim);
    await join(friend, victim);
    const victimUserId = await userIdOf(victim);
    const friendUserId = await userIdOf(friend);

    const deleted = await api('/auth/delete-account', victim.session({
      method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }),
    }));
    expect(deleted.response.status).toBe(200);

    const count = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).first()).n;
    expect(await count('SELECT COUNT(*) AS n FROM avatar_presence WHERE user_id = ?', victimUserId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM nearby_chat_messages WHERE user_id = ?', victimUserId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM voice_signaling_messages WHERE from_user_id = ? OR to_user_id = ?', victimUserId, victimUserId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM friend_voice_channel_members WHERE owner_user_id = ? OR member_user_id = ?', victimUserId, victimUserId)).toBe(0);
    // The friend's own rows are untouched.
    expect(await count('SELECT COUNT(*) AS n FROM avatar_presence WHERE user_id = ?', friendUserId)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM nearby_chat_messages WHERE user_id = ?', friendUserId)).toBe(1);
  });
});
