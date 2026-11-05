// #3146 (3/6 of #3141): direct_messages are stored against the two accounts
// (users.user_id), not the resettable builder profile. The wire still names
// people by their current builder id.
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
}

const send = (from, to, text) => api('/direct-messages', from.session({
  method: 'POST', body: JSON.stringify({ recipientBuilderId: to.builderId, text }),
}));

async function userIdOf(builder) {
  return (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(builder.builderId).first()).user_id;
}

// Resetting a builder profile is DELETE /api/builders/:id; the next
// /builders/me creates a brand-new one for the same account.
async function resetBuilderProfile(person) {
  const deleted = await api(`/builders/${person.builderId}`, person.session({ method: 'DELETE' }));
  expect(deleted.response.status).toBe(200);
  const fresh = await api('/builders/me', person.session());
  expect(fresh.body.builder.builderId).not.toBe(person.builderId);
  return fresh.body.builder.builderId;
}

describe('Direct messages keyed on the account (#3146)', () => {
  it('stores user ids, leaves the retired builder-id columns unwritten, and returns both ids on the wire', async () => {
    const alice = await signupIdVerifiedBuilder('dmuid-store-alice');
    const bob = await signupIdVerifiedBuilder('dmuid-store-bob');
    await becomeFriends(alice, bob);
    const sent = await send(alice, bob, 'hello');
    expect(sent.response.status).toBe(201);
    expect(sent.body.message).toMatchObject({
      senderUserId: await userIdOf(alice), recipientUserId: await userIdOf(bob),
      senderBuilderId: alice.builderId, recipientBuilderId: bob.builderId,
    });
    const row = await env.DB.prepare('SELECT * FROM direct_messages WHERE message_id = ?').bind(sent.body.message.messageId).first();
    expect(row.sender_user_id).toBe(await userIdOf(alice));
    expect(row.recipient_user_id).toBe(await userIdOf(bob));
    expect(row.sender_builder_id).toBeNull();
    expect(row.recipient_builder_id).toBeNull();
  });

  it('keeps the thread, unread count and mark-read working after the RECIPIENT resets their builder profile', async () => {
    const alice = await signupIdVerifiedBuilder('dmuid-recipient-reset-alice');
    const bob = await signupIdVerifiedBuilder('dmuid-recipient-reset-bob');
    await becomeFriends(alice, bob);
    await send(alice, bob, 'one');
    await send(alice, bob, 'two');
    expect((await api('/direct-messages/unread-count', bob.session())).body.count).toBe(2);

    const bobNewBuilderId = await resetBuilderProfile(bob);

    // Unread count is the person's, not the profile's.
    expect((await api('/direct-messages/unread-count', bob.session())).body.count).toBe(2);
    // Alice reaches the same thread by Bob's current builder id, and the
    // wire shows Bob's current id on his side.
    const thread = await api(`/direct-messages?withBuilderId=${bobNewBuilderId}`, alice.session());
    expect(thread.body.messages.map((m) => m.text).sort()).toEqual(['one', 'two']);
    expect(thread.body.messages.every((m) => m.recipientBuilderId === bobNewBuilderId && m.senderBuilderId === alice.builderId)).toBe(true);
    // Bob marks it read by Alice's id and the badge clears.
    await api('/direct-messages/mark-read', bob.session({ method: 'POST', body: JSON.stringify({ withBuilderId: alice.builderId }) }));
    expect((await api('/direct-messages/unread-count', bob.session())).body.count).toBe(0);
  });

  it('keeps the thread after the SENDER resets their builder profile, and a new message still goes through', async () => {
    const alice = await signupIdVerifiedBuilder('dmuid-sender-reset-alice');
    const bob = await signupIdVerifiedBuilder('dmuid-sender-reset-bob');
    await becomeFriends(alice, bob);
    await send(alice, bob, 'before');
    await resetBuilderProfile(alice);

    // Friendships are still builder-keyed until 2/6, so the reset ends the
    // friendship today; restore it the way the test already does, then
    // confirm the old message is still in the thread under the new profile.
    const aliceNow = (await api('/builders/me', alice.session())).body.builder;
    const aliceFresh = { ...alice, builderId: aliceNow.builderId };
    await becomeFriends(aliceFresh, bob);
    const after = await send(aliceFresh, bob, 'after');
    expect(after.response.status).toBe(201);
    const thread = await api(`/direct-messages?withBuilderId=${aliceNow.builderId}`, bob.session());
    expect(thread.body.messages.map((m) => m.text).sort()).toEqual(['after', 'before']);
  });

  it('bills the send quota to the account, so a profile reset does not hand out a fresh one', async () => {
    const alice = await signupIdVerifiedBuilder('dmuid-quota-alice');
    const bob = await signupIdVerifiedBuilder('dmuid-quota-bob');
    await becomeFriends(alice, bob);
    await send(alice, bob, 'x');
    const aliceUserId = await userIdOf(alice);
    const counted = await env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limit_events WHERE bucket_key = ?')
      .bind(`direct-message-send:${aliceUserId}`).first();
    expect(counted.c).toBe(1);
    const oldKey = await env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limit_events WHERE bucket_key = ?')
      .bind(`direct-message-send:${alice.builderId}`).first();
    expect(oldKey.c).toBe(0);
  });

  it('does not break a list on a legacy row whose accounts could not be recovered, and does not drop it', async () => {
    const alice = await signupIdVerifiedBuilder('dmuid-legacy-alice');
    const bob = await signupIdVerifiedBuilder('dmuid-legacy-bob');
    await becomeFriends(alice, bob);
    await send(alice, bob, 'real');
    // A pre-migration row for builders that no longer exist: builder ids only.
    await env.DB.prepare(`
      INSERT INTO direct_messages (message_id, sender_builder_id, recipient_builder_id, text)
      VALUES ('legacy-1', 'builder-gone-a', 'builder-gone-b', 'orphan')
    `).run();
    const thread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(thread.body.messages.map((m) => m.text)).toEqual(['real']);
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM direct_messages WHERE message_id = 'legacy-1'").first()).c).toBe(1);
    expect((await api('/direct-messages/unread-count', bob.session())).body.count).toBe(1);
  });

  it('reads sensibly to the other person after a deleted account: nothing lost, the gone side has no builder id', async () => {
    const alice = await signupIdVerifiedBuilder('dmuid-deleted-alice');
    const bob = await signupIdVerifiedBuilder('dmuid-deleted-bob');
    await becomeFriends(alice, bob);
    await send(alice, bob, 'to bob');
    await send(bob, alice, 'to alice');
    const bobUserId = await userIdOf(bob);

    const deletion = await api('/auth/delete-account', bob.session({
      method: 'POST', body: JSON.stringify({ password: 'a fine long password here' }),
    }));
    expect(deletion.response.status).toBe(200);

    // Both rows are still stored and Alice still receives hers.
    expect((await env.DB.prepare('SELECT COUNT(*) AS c FROM direct_messages WHERE sender_user_id = ? OR recipient_user_id = ?')
      .bind(bobUserId, bobUserId).first()).c).toBe(2);
    expect((await api('/direct-messages/unread-count', alice.session())).body.count).toBe(1);
    // A thread opened with Bob's old builder id (which names no one now)
    // reads as empty rather than erroring.
    const thread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(thread.response.status).toBe(200);
    expect(thread.body.messages).toEqual([]);
    // Alice's own data export still carries both messages, Bob's side with no builder id.
    const exported = await api('/auth/export-data', alice.session());
    const dms = exported.body.social.directMessages;
    expect(dms.map((m) => m.text).sort()).toEqual(['to alice', 'to bob']);
    expect(dms.find((m) => m.text === 'to alice')).toMatchObject({ senderBuilderId: null, recipientBuilderId: alice.builderId });
  });
});
