// #4407 (part 2): the admin dashboard's Rename, the owner's tool for the one existing name with a space.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';
import { usernameSkeleton } from './lib/username-rules.js';

let admin;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  admin = await signupAdmin('rename-acct-admin');
});

const userIdOf = async (email) => (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(email).first()).user_id;
const rename = (userId, newUsername, session = admin.session) => api('/auth/admin-rename-account', session({ method: 'POST', body: JSON.stringify({ userId, newUsername }) }));

// A name with a space cannot be signed up any more, so the fixture is made the way an old account was: directly.
async function personWithSpacedName(label, spaced) {
  const person = await signupBuilder(label);
  const userId = await userIdOf(person.email);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET username = ?, username_skeleton = ? WHERE user_id = ?').bind(spaced, usernameSkeleton(spaced), userId),
    env.DB.prepare('UPDATE builders SET label = ? WHERE builder_id = ?').bind(spaced, person.builderId),
  ]);
  return { person, userId };
}

describe('Admin rename account (#4407)', () => {
  it('refuses a signed-out caller and a non-admin', async () => {
    const { person, userId } = await personWithSpacedName('rename-acct-a', 'Ada Spaced A');
    expect((await api('/auth/admin-rename-account', { method: 'POST', body: JSON.stringify({ userId, newUsername: 'AdaSpacedA' }) })).response.status).toBe(401);
    expect((await rename(userId, 'AdaSpacedA', person.session)).response.status).toBe(403);
    expect((await env.DB.prepare('SELECT username FROM users WHERE user_id = ?').bind(userId).first()).username).toBe('Ada Spaced A');
  });

  it('renames the username and the builder label together, tells the person, and writes the admin log', async () => {
    const { person, userId } = await personWithSpacedName('rename-acct-b', 'Ada Spaced B');
    const done = await rename(userId, 'AdaSpacedB');
    expect(done.response.status).toBe(200);
    expect(done.body).toMatchObject({ renamed: true, oldUsername: 'Ada Spaced B', username: 'AdaSpacedB' });
    const row = await env.DB.prepare('SELECT username, username_skeleton FROM users WHERE user_id = ?').bind(userId).first();
    expect(row).toEqual({ username: 'AdaSpacedB', username_skeleton: 'adaspacedb' });
    expect((await api('/builders/me', person.session())).body.builder.label).toBe('AdaSpacedB');
    expect((await api('/auth/me', person.session())).body.user.username).toBe('AdaSpacedB');

    const { results } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?').bind(person.builderId).all();
    const notice = results.map((r) => r.message).find((m) => m.includes('name was changed'));
    expect(notice).toContain('"Ada Spaced B"');
    expect(notice).toContain('"AdaSpacedB"');
    expect(notice).not.toMatch(/#\d|docs\/|admin/i);
    const log = await env.DB.prepare(`SELECT detail_json FROM admin_action_log WHERE action_type = 'rename_account' AND target_id = ?`).bind(userId).first();
    expect(JSON.parse(log.detail_json)).toEqual({ oldUsername: 'Ada Spaced B', newUsername: 'AdaSpacedB' });
  });

  it('applies the sign-up rule: no spaces, no reserved names, no name another person holds', async () => {
    const { userId } = await personWithSpacedName('rename-acct-c', 'Ada Spaced C');
    const holder = await signupBuilder('RenameAcctHolder');
    const withSpace = await rename(userId, 'Ada Spaced C2');
    expect(withSpace.response.status).toBe(400);
    expect(withSpace.body.error).toMatch(/can't have spaces/);
    expect((await rename(userId, 'higglehaven17')).response.status).toBe(409);
    expect((await rename(userId, 'Admin')).response.status).toBe(409);
    expect((await rename(userId, 'renameacctholder')).response.status).toBe(409); // other case of someone's name
    expect(holder.builderId).toBeTruthy();
    expect((await rename(userId, 'Ada Spaced C')).response.status).toBe(400); // still has spaces
    expect((await env.DB.prepare('SELECT username FROM users WHERE user_id = ?').bind(userId).first()).username).toBe('Ada Spaced C');
  });

  it('refuses a fleet account, a deleted account, an unknown id and a missing id', async () => {
    const { userId } = await personWithSpacedName('rename-acct-d', 'Ada Spaced D');
    await env.DB.prepare('UPDATE users SET is_fleet = 1 WHERE user_id = ?').bind(userId).run();
    expect((await rename(userId, 'AdaSpacedD')).response.status).toBe(409);
    await env.DB.prepare('UPDATE users SET is_fleet = 0, deleted_at = ? WHERE user_id = ?').bind('2026-01-01T00:00:00.000Z', userId).run();
    expect((await rename(userId, 'AdaSpacedD')).response.status).toBe(409);
    expect((await rename('user-does-not-exist', 'Whoever')).response.status).toBe(404);
    expect((await rename('', 'Whoever')).response.status).toBe(400);
  });
});
