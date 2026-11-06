import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

// #3145 (2/6 of #3141): friendships key on the account (user_id), so they
// survive either person resetting their builder profile.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function userIdOf(builderId) {
  return (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(builderId).first()).user_id;
}

async function signupIdVerifiedBuilder(label) {
  const builder = await signupBuilder(label);
  await env.DB.prepare('UPDATE users SET trust_tier = ? WHERE user_id = ?')
    .bind('id_verified', await userIdOf(builder.builderId)).run();
  return builder;
}

async function becomeFriends(a, b) {
  const sent = await api('/friendships', a.session({
    method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
  }));
  expect(sent.response.status).toBe(201);
  const accepted = await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({
    method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
  }));
  expect(accepted.response.status).toBe(200);
  return sent.body.friendship.friendshipId;
}

// A person's builder profile can be reset through ordinary self-service: it is
// deleted and the next authenticated request creates a fresh one.
async function resetBuilderProfile(person) {
  const deleted = await api(`/builders/${person.builderId}`, person.session({ method: 'DELETE' }));
  expect(deleted.response.status).toBe(200);
  const fresh = await api('/builders/me', person.session());
  expect(fresh.response.status).toBe(200);
  return fresh.body.builder.builderId;
}

describe('Friendships key on the account (#3145)', () => {
  it('stores user ids and reports both the stable account id and the current builder id', async () => {
    const alice = await signupBuilder('fr-uid-alice');
    const bob = await signupBuilder('fr-uid-bob');
    const friendshipId = await becomeFriends(alice, bob);

    const row = await env.DB.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(friendshipId).first();
    expect(row.requester_user_id).toBe(await userIdOf(alice.builderId));
    expect(row.recipient_user_id).toBe(await userIdOf(bob.builderId));

    const list = await api('/friendships', alice.session());
    expect(list.body.friendships).toHaveLength(1);
    expect(list.body.friendships[0]).toMatchObject({
      friendshipId,
      status: 'accepted',
      direction: 'outgoing',
      requesterBuilderId: alice.builderId,
      recipientBuilderId: bob.builderId,
      otherBuilderId: bob.builderId,
      otherUserId: await userIdOf(bob.builderId),
      otherLabel: 'fr-uid-bob',
    });
    const bobList = await api('/friendships', bob.session());
    expect(bobList.body.friendships[0].direction).toBe('incoming');
  });

  it('keeps the friendship, and shows the friend\'s new builder id, after the REQUESTER resets their profile', async () => {
    const alice = await signupBuilder('fr-uid-reset-req-alice');
    const bob = await signupBuilder('fr-uid-reset-req-bob');
    const friendshipId = await becomeFriends(alice, bob);

    const aliceNewBuilderId = await resetBuilderProfile(alice);
    expect(aliceNewBuilderId).not.toBe(alice.builderId);

    const bobList = await api('/friendships', bob.session());
    expect(bobList.body.friendships).toHaveLength(1);
    expect(bobList.body.friendships[0].friendshipId).toBe(friendshipId);
    expect(bobList.body.friendships[0].status).toBe('accepted');
    expect(bobList.body.friendships[0].otherBuilderId).toBe(aliceNewBuilderId);

    const aliceList = await api('/friendships', alice.session());
    expect(aliceList.body.friendships).toHaveLength(1);
    expect(aliceList.body.friendships[0].otherBuilderId).toBe(bob.builderId);
  });

  it('keeps the friendship after the RECIPIENT resets their profile, and a pending request survives too', async () => {
    const alice = await signupBuilder('fr-uid-reset-rec-alice');
    const bob = await signupBuilder('fr-uid-reset-rec-bob');
    const carol = await signupBuilder('fr-uid-reset-rec-carol');
    const accepted = await becomeFriends(alice, bob);
    const pending = await api('/friendships', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: carol.builderId }),
    }));
    expect(pending.response.status).toBe(201);

    await resetBuilderProfile(bob);
    await resetBuilderProfile(carol);

    const aliceList = await api('/friendships', alice.session());
    expect(aliceList.body.friendships.map((f) => f.friendshipId).sort())
      .toEqual([accepted, pending.body.friendship.friendshipId].sort());
    // Carol can still accept the request she received before resetting.
    const carolAccepts = await api(`/friendships/${pending.body.friendship.friendshipId}`, carol.session({
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    }));
    expect(carolAccepts.response.status).toBe(200);
  });

  it('still lets friends message each other after one resets their profile', async () => {
    const alice = await signupIdVerifiedBuilder('fr-uid-dm-alice');
    const bob = await signupIdVerifiedBuilder('fr-uid-dm-bob');
    await becomeFriends(alice, bob);

    const bobNewBuilderId = await resetBuilderProfile(bob);
    const sent = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bobNewBuilderId, text: 'still friends?' }),
    }));
    expect(sent.response.status).toBe(201);
  });

  it('still refuses a message between people who are not friends', async () => {
    const alice = await signupIdVerifiedBuilder('fr-uid-nofriend-alice');
    const bob = await signupIdVerifiedBuilder('fr-uid-nofriend-bob');
    const refused = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'hello' }),
    }));
    expect(refused.response.status).toBe(403);
  });

  it('lists a friend who has no builder profile right now by their username, with a null builder id', async () => {
    const alice = await signupBuilder('fr-uid-nobuilder-alice');
    const bob = await signupBuilder('fr-uid-nobuilder-bob');
    await becomeFriends(alice, bob);
    // Bob's profile is removed and not yet re-created.
    await api(`/builders/${bob.builderId}`, bob.session({ method: 'DELETE' }));

    const list = await api('/friendships', alice.session());
    expect(list.body.friendships).toHaveLength(1);
    expect(list.body.friendships[0].otherBuilderId).toBeNull();
    expect(list.body.friendships[0].otherLabel).toBe('fr-uid-nobuilder-bob');
  });

  it('refuses to befriend yourself under a second profile id, and an unknown builder', async () => {
    const alice = await signupBuilder('fr-uid-self-alice');
    const self = await api('/friendships', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: alice.builderId }),
    }));
    expect(self.response.status).toBe(400);
    const unknown = await api('/friendships', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: 'builder-does-not-exist' }),
    }));
    expect(unknown.response.status).toBe(400);
  });

  it('does not let a second request be created for the same pair, in either direction', async () => {
    const alice = await signupBuilder('fr-uid-dup-alice');
    const bob = await signupBuilder('fr-uid-dup-bob');
    await becomeFriends(alice, bob);
    const again = await api('/friendships', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId }),
    }));
    expect(again.response.status).toBe(409);
    const reverse = await api('/friendships', bob.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: alice.builderId }),
    }));
    expect(reverse.response.status).toBe(409);
  });

  it('removes the account\'s friendships when the account is deleted', async () => {
    const alice = await signupBuilder('fr-uid-acctdel-alice');
    const bob = await signupBuilder('fr-uid-acctdel-bob');
    const friendshipId = await becomeFriends(alice, bob);

    const deleted = await api('/auth/delete-account', alice.session({
      method: 'POST', body: JSON.stringify({ password: 'a fine long password here' }),
    }));
    expect(deleted.response.status).toBe(200);

    const gone = await env.DB.prepare('SELECT 1 FROM friendships WHERE friendship_id = ?').bind(friendshipId).first();
    expect(gone).toBeNull();
    const bobList = await api('/friendships', bob.session());
    expect(bobList.body.friendships).toEqual([]);
  });

  it('a friendship row whose accounts could not be recovered stays in place and does not break a list', async () => {
    // Simulates a row the backfills could not resolve: both user ids NULL.
    await env.DB.prepare(
      'INSERT INTO friendships (friendship_id, requester_user_id, recipient_user_id) VALUES (?, NULL, NULL)',
    ).bind('friendship-unrecoverable').run();
    const alice = await signupBuilder('fr-uid-inert-alice');
    const list = await api('/friendships', alice.session());
    expect(list.response.status).toBe(200);
    expect(list.body.friendships).toEqual([]);
    const row = await env.DB.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind('friendship-unrecoverable').first();
    expect(row).not.toBeNull();
    expect(row.requester_user_id).toBeNull();
  });
});
