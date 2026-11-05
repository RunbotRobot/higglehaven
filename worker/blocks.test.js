// #3140 (sub-issue 1/2 of #3124): durable, silent blocks keyed on user_id.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function userIdOf(account) {
  const row = await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(account.email).first();
  return row.user_id;
}

const post = (account, body) => api('/blocks', account.session({ method: 'POST', body: JSON.stringify(body) }));

async function notificationCount(...builders) {
  const ids = builders.map((b) => b.builderId);
  const marks = ids.map(() => '?').join(',');
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE builder_id IN (${marks})`)
    .bind(...ids).first();
  return row.n;
}

describe('Blocks (#3140)', () => {
  it('requires a signed-in account', async () => {
    expect((await api('/blocks')).response.status).toBe(401);
    expect((await api('/blocks', { method: 'POST', body: JSON.stringify({ userId: 'x' }) })).response.status).toBe(401);
  });

  it('blocks by builder id or user id, lists by username, and unblocks idempotently', async () => {
    const alice = await signupBuilder('blk-rt-alice');
    const bob = await signupBuilder('blk-rt-bob');
    const carol = await signupBuilder('blk-rt-carol');
    const bobUserId = await userIdOf(bob);
    const carolUserId = await userIdOf(carol);

    const byBuilder = await post(alice, { builderId: bob.builderId });
    expect(byBuilder.response.status).toBe(201);
    expect(byBuilder.body).toMatchObject({ blocked: true, userId: bobUserId });
    expect((await post(alice, { userId: carolUserId })).response.status).toBe(201);

    const listed = await api('/blocks', alice.session());
    expect(listed.body.blocks.map((b) => b.username).sort()).toEqual(['blk-rt-bob', 'blk-rt-carol']);
    expect(listed.body.blocks.find((b) => b.userId === bobUserId).blockedAt).toBeTruthy();

    // Blocking again is the same success and does not duplicate the row.
    expect((await post(alice, { builderId: bob.builderId })).response.status).toBe(201);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_user_id = ?')
      .bind(await userIdOf(alice)).first();
    expect(count.n).toBe(2);

    const removed = await api(`/blocks/${bobUserId}`, alice.session({ method: 'DELETE' }));
    expect(removed.response.status).toBe(200);
    const again = await api(`/blocks/${bobUserId}`, alice.session({ method: 'DELETE' }));
    expect(again.response.status).toBe(200);
    const after = await api('/blocks', alice.session());
    expect(after.body.blocks.map((b) => b.username)).toEqual(['blk-rt-carol']);
  });

  it('rejects blocking yourself, a missing target, or a request with no target', async () => {
    const alice = await signupBuilder('blk-bad-alice');
    expect((await post(alice, { builderId: alice.builderId })).response.status).toBe(400);
    expect((await post(alice, { userId: await userIdOf(alice) })).response.status).toBe(400);
    expect((await post(alice, { builderId: 'no-such-builder' })).response.status).toBe(404);
    expect((await post(alice, { userId: 'no-such-user' })).response.status).toBe(404);
    expect((await post(alice, {})).response.status).toBe(400);
  });

  it('silently severs an accepted friendship and drops a pending request, in both directions', async () => {
    const alice = await signupBuilder('blk-fr-alice');
    const bob = await signupBuilder('blk-fr-bob');
    const carol = await signupBuilder('blk-fr-carol');

    // alice <-> bob accepted; carol -> alice pending.
    const sent = await api('/friendships', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId }),
    }));
    await api(`/friendships/${sent.body.friendship.friendshipId}`, bob.session({
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    }));
    await api('/friendships', carol.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: alice.builderId }),
    }));
    expect((await api('/friendships', alice.session())).body.friendships).toHaveLength(2);

    const notificationsBefore = await notificationCount(alice, bob, carol);
    expect((await post(alice, { builderId: bob.builderId })).response.status).toBe(201);
    expect((await post(alice, { builderId: carol.builderId })).response.status).toBe(201);

    expect((await api('/friendships', alice.session())).body.friendships).toHaveLength(0);
    expect((await api('/friendships', bob.session())).body.friendships).toHaveLength(0);
    expect((await api('/friendships', carol.session())).body.friendships).toHaveLength(0);
    // A block is silent: nobody was notified of anything.
    expect(await notificationCount(alice, bob, carol)).toBe(notificationsBefore);
  });

  it('tells the blocked person nothing: no notification and an empty block list of their own', async () => {
    const alice = await signupBuilder('blk-silent-alice');
    const bob = await signupBuilder('blk-silent-bob');
    const before = await notificationCount(bob);
    await post(alice, { builderId: bob.builderId });
    expect(await notificationCount(bob)).toBe(before);

    const bobsView = await api('/blocks', bob.session());
    expect(bobsView.body.blocks).toEqual([]);
    expect(JSON.stringify(bobsView.body)).not.toContain(await userIdOf(alice));
  });

  it('removes a deleted account\'s blocks in both directions and leaves other people\'s alone', async () => {
    const password = 'a fine long password here';
    const alice = await signupBuilder('blk-del-alice');
    const bob = await signupBuilder('blk-del-bob');
    const carol = await signupBuilder('blk-del-carol');
    const aliceId = await userIdOf(alice);
    const bobId = await userIdOf(bob);
    const carolId = await userIdOf(carol);

    await post(alice, { userId: bobId }); // placed by the deleted account
    await post(carol, { userId: aliceId }); // placed on the deleted account
    await post(carol, { userId: bobId }); // unrelated to it

    // signupBuilder's password is the fixed test one.
    const deletion = await api('/auth/delete-account', alice.session({
      method: 'POST', body: JSON.stringify({ password }),
    }));
    expect(deletion.response.status).toBe(200);

    const rows = await env.DB.prepare('SELECT blocker_user_id AS a, blocked_user_id AS b FROM user_blocks WHERE blocker_user_id = ? OR blocked_user_id = ?')
      .bind(aliceId, aliceId).all();
    expect(rows.results).toEqual([]);
    const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?')
      .bind(carolId, bobId).first();
    expect(kept.n).toBe(1);
  });
});
