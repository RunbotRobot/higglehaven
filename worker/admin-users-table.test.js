// #4060: GET /auth/admin-users, the admin dashboard's table of users.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller, signupAdmin } from './test-helpers.js';
import { ADMIN_USER_COLUMNS, ADMIN_USERS_LIMIT } from './lib/admin-users-table.js';

let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('users-table-admin')).session;
});

describe('GET /auth/admin-users (#4060)', () => {
  it('refuses a signed-out caller', async () => {
    const anon = await api('/auth/admin-users');
    expect(anon.response.status).toBe(401);
  });

  it('refuses a signed-in non-admin', async () => {
    const builder = await signupBuilder('users-table-non-admin');
    const attempt = await api('/auth/admin-users', builder.session());
    expect(attempt.response.status).toBe(403);
  });

  it('returns the column definitions and one row per user, with the counts joined in', async () => {
    const builder = await signupBuilder('users-table-builder');
    await signupSeller('users-table-seller');
    const result = await api('/auth/admin-users', adminSession());
    expect(result.response.status).toBe(200);
    expect(result.body.limit).toBe(ADMIN_USERS_LIMIT);
    expect(result.body.truncated).toBe(false);
    expect(result.body.total).toBe(result.body.users.length);
    expect(result.body.columns.map((c) => c.key)).toEqual(ADMIN_USER_COLUMNS.map((c) => c.key));
    const row = result.body.users.find((u) => u.email === builder.email);
    expect(row).toBeTruthy();
    expect(row.username).toBe('users-table-builder');
    expect(row.kind).toBe('Person');
    expect(row.hasBuilder).toBe(true);
    expect(row.landletsClaimed).toBe(0);
    expect(row.sessionsOpen).toBeGreaterThanOrEqual(1);
    expect(row.suspended).toBe(false);
    // Every defined column has a value (possibly null) on every row, so the page never reads an undefined.
    for (const col of result.body.columns) expect(Object.prototype.hasOwnProperty.call(row, col.key)).toBe(true);
    const admin = result.body.users.find((u) => u.username === 'users-table-admin');
    expect(admin.kind).toBe('Admin');
  });

  it('never returns the password hash, a tax id, a session token or any of their values', async () => {
    const builder = await signupBuilder('users-table-secrets');
    const stored = await env.DB.prepare('SELECT password_hash FROM users WHERE email = ?').bind(builder.email).first();
    await env.DB.prepare("UPDATE users SET tax_id_encrypted = 'ENCRYPTED-TAX-ID-VALUE-4060' WHERE email = ?").bind(builder.email).run();
    const result = await api('/auth/admin-users', adminSession());
    const text = JSON.stringify(result.body);
    expect(text).not.toContain(stored.password_hash);
    expect(text).not.toContain('ENCRYPTED-TAX-ID-VALUE-4060');
    expect(text).not.toContain(builder.sessionToken);
    expect(text).not.toMatch(/password_hash|passwordHash|tax_id_encrypted|taxIdEncrypted|token_hash|tokenHash/);
    const row = result.body.users.find((u) => u.email === builder.email);
    expect(row.taxIdOnFile).toBe(true);
  });

  it('counts a suspension, an accepted friendship and a block', async () => {
    const a = await signupBuilder('users-table-friend-a');
    const b = await signupBuilder('users-table-friend-b');
    const ids = async (email) => (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(email).first()).user_id;
    const [ua, ub] = [await ids(a.email), await ids(b.email)];
    await env.DB.prepare("INSERT INTO friendships (friendship_id, requester_user_id, recipient_user_id, status) VALUES ('fr-4060', ?, ?, 'accepted')").bind(ua, ub).run();
    await env.DB.prepare('INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES (?, ?)').bind(ua, ub).run();
    await env.DB.prepare("INSERT INTO account_suspensions (suspension_id, user_id, admin_user_id, reason, grace_period_ends_at) VALUES ('sus-4060', ?, ?, 'x', '2099-01-01T00:00:00Z')").bind(ub, ua).run();
    const result = await api('/auth/admin-users', adminSession());
    const rowA = result.body.users.find((u) => u.userId === ua);
    const rowB = result.body.users.find((u) => u.userId === ub);
    expect(rowA.friendsCount).toBe(1);
    expect(rowB.friendsCount).toBe(1);
    expect(rowA.blocksMade).toBe(1);
    expect(rowB.blocksMade).toBe(0);
    expect(rowB.suspended).toBe(true);
    expect(rowA.suspended).toBe(false);
  });
});
