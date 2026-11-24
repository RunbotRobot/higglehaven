// #4077: the admin dashboard's Delete account. It runs the same cascade a person's own deletion runs.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller, signupAdmin, createGreenbeltLandletAs } from './test-helpers.js';

let adminSession;
let admin;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  admin = await signupAdmin('delete-acct-admin');
  adminSession = admin.session;
});

const userIdOf = async (email) => (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(email).first()).user_id;
const del = (body, session = adminSession) => api('/auth/admin-delete-account', session({ method: 'POST', body: JSON.stringify(body) }));

describe('Admin delete account (#4077)', () => {
  it('refuses a signed-out caller and a non-admin, for both routes', async () => {
    const person = await signupBuilder('delete-acct-person-a');
    const userId = await userIdOf(person.email);
    expect((await api('/auth/admin-delete-account-preview?userId=' + userId)).response.status).toBe(401);
    expect((await api('/auth/admin-delete-account-preview?userId=' + userId, person.session())).response.status).toBe(403);
    expect((await api('/auth/admin-delete-account', { method: 'POST', body: JSON.stringify({ userId }) })).response.status).toBe(401);
    expect((await del({ userId, confirmUsername: 'delete-acct-person-a' }, person.session)).response.status).toBe(403);
  });

  it('previews counts and no refusal for an ordinary account', async () => {
    const person = await signupSeller('delete-acct-preview');
    const userId = await userIdOf(person.email);
    const preview = await api('/auth/admin-delete-account-preview?userId=' + userId, adminSession());
    expect(preview.response.status).toBe(200);
    expect(preview.body.account.username).toBe('delete-acct-preview');
    expect(preview.body.counts).toEqual({ landletsClaimed: 0, productsListed: 0, ordersAsBuyer: 0, ordersAsSeller: 0, friends: 0 });
    expect(preview.body.refusal).toBeNull();
  });

  it('refuses without the typed username, then deletes like self-deletion and records it', async () => {
    const person = await signupBuilder('delete-acct-target');
    const userId = await userIdOf(person.email);
    const wrong = await del({ userId, confirmUsername: 'nope' });
    expect(wrong.response.status).toBe(400);
    expect((await api('/auth/me', person.session())).body.user).not.toBeNull();

    const done = await del({ userId, confirmUsername: 'delete-acct-target' });
    expect(done.response.status).toBe(200);
    expect(done.body.accountDeleted).toBe(true);
    expect((await api('/auth/me', person.session())).body.user).toBeNull();
    const row = await env.DB.prepare('SELECT username, deleted_at FROM users WHERE user_id = ?').bind(userId).first();
    expect(row.username).toBe(`deleted-${userId.slice(-8)}`);
    expect(row.deleted_at).toBeTruthy();
    expect(await env.DB.prepare('SELECT builder_id FROM builders WHERE builder_id = ?').bind(person.builderId).first()).toBeFalsy();
    const log = await env.DB.prepare(`SELECT detail_json FROM admin_action_log WHERE action_type = 'delete_account' AND target_id = ?`).bind(userId).first();
    expect(JSON.parse(log.detail_json).username).toBe('delete-acct-target');

    const again = await del({ userId, confirmUsername: 'delete-acct-target' });
    expect(again.response.status).toBe(409);
  });

  it('refuses the admin\'s own account and another admin', async () => {
    const adminId = await userIdOf(admin.email);
    const own = await del({ userId: adminId, confirmUsername: 'delete-acct-admin' });
    expect(own.response.status).toBe(409);
    const other = await signupAdmin('delete-acct-other-admin');
    const otherId = await userIdOf(other.email);
    const refused = await del({ userId: otherId, confirmUsername: 'delete-acct-other-admin' });
    expect(refused.response.status).toBe(409);
  });

  it('refuses an account that still owns a lándlet, and leaves it intact', async () => {
    const builder = await signupBuilder('delete-acct-owner');
    const userId = await userIdOf(builder.email);
    await createGreenbeltLandletAs(adminSession, 'delete-acct-landlet');
    await api('/landlets/delete-acct-landlet/claim', builder.session({ method: 'POST' }));
    const preview = await api('/auth/admin-delete-account-preview?userId=' + userId, adminSession());
    expect(preview.body.counts.landletsClaimed).toBe(1);
    expect(preview.body.refusal).toMatch(/greenbelt/);
    const refused = await del({ userId, confirmUsername: 'delete-acct-owner' });
    expect(refused.response.status).toBe(409);
    expect((await api('/auth/me', builder.session())).body.user).not.toBeNull();
  });

  it('refuses a fleet account unless the second tick is given', async () => {
    const fleet = await signupBuilder('delete-acct-fleet');
    const userId = await userIdOf(fleet.email);
    await env.DB.prepare('UPDATE users SET is_fleet = 1 WHERE user_id = ?').bind(userId).run();
    const preview = await api('/auth/admin-delete-account-preview?userId=' + userId, adminSession());
    expect(preview.body.refusal).toMatch(/Tick the box/);
    expect(preview.body.needsFleetTick).toBe(true);
    expect((await del({ userId, confirmUsername: 'delete-acct-fleet' })).response.status).toBe(409);
    expect((await del({ userId, confirmUsername: 'delete-acct-fleet', includeFleet: true })).response.status).toBe(200);
  });
});
