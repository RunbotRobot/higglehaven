// #2033 (sub-issue of #1201): an admin-initiated suspension (#2029) that
// nobody lifts within its own grace_period_ends_at auto-escalates into the
// same real account deletion handleDeleteAccount already runs for a
// self-delete -- escalateExpiredSuspensions, called from scheduled() on the
// existing cron. Mirrors warnInactiveLandletOwners-style tests
// (worker/auctions.test.js) -- a direct call against env.DB, not an HTTP
// round trip, since there's no request behind a scheduled cron job.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { escalateExpiredSuspensions } from './index.js';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function userIdFor(target) {
  const me = await api('/auth/me', target.session());
  return me.body.user.userId;
}

async function insertSuspension(userId, { gracePeriodEndsAt, liftedAt = null, escalatedAt = null }) {
  const suspensionId = `suspension-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO account_suspensions
      (suspension_id, user_id, admin_user_id, reason, grace_period_ends_at, lifted_at, escalated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(suspensionId, userId, userId, 'x', gracePeriodEndsAt, liftedAt, escalatedAt).run();
  return suspensionId;
}

describe('escalateExpiredSuspensions (#2033)', () => {
  it('escalates a suspension whose grace period has passed into a real account deletion, with an audit log entry', async () => {
    const target = await signupBuilder('escalate-due-target');
    const userId = await userIdFor(target);
    const pastGracePeriod = new Date(Date.now() - 1000).toISOString();
    const suspensionId = await insertSuspension(userId, { gracePeriodEndsAt: pastGracePeriod });

    await escalateExpiredSuspensions(env.DB);

    const userRow = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
    expect(userRow.deleted_at).toBeTruthy();
    expect(userRow.email).not.toBe(target.email);
    expect(userRow.email.endsWith('@deleted.invalid')).toBe(true);

    // Every session is wiped -- the account's own prior session no longer
    // authenticates at all.
    const stillLoggedIn = await api('/auth/me', target.session());
    expect(stillLoggedIn.body.user).toBeNull();

    const suspensionRow = await env.DB.prepare('SELECT * FROM account_suspensions WHERE suspension_id = ?')
      .bind(suspensionId).first();
    expect(suspensionRow.escalated_at).toBeTruthy();

    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('auto_escalate_suspension', userId).first();
    expect(logRow).toBeTruthy();
    expect(logRow.admin_user_id).toBeNull();
    expect(JSON.parse(logRow.detail_json).suspensionId).toBe(suspensionId);
  });

  it('leaves a suspension whose grace period has not yet passed untouched', async () => {
    const target = await signupBuilder('escalate-not-due-target');
    const userId = await userIdFor(target);
    const futureGracePeriod = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await insertSuspension(userId, { gracePeriodEndsAt: futureGracePeriod });

    await escalateExpiredSuspensions(env.DB);

    const userRow = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
    expect(userRow.deleted_at).toBeNull();
    expect(userRow.email).toBe(target.email);
  });

  it('never escalates a suspension that was lifted before its grace period passed', async () => {
    const target = await signupBuilder('escalate-lifted-target');
    const userId = await userIdFor(target);
    const pastGracePeriod = new Date(Date.now() - 1000).toISOString();
    await insertSuspension(userId, {
      gracePeriodEndsAt: pastGracePeriod, liftedAt: new Date().toISOString(),
    });

    await escalateExpiredSuspensions(env.DB);

    const userRow = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
    expect(userRow.deleted_at).toBeNull();
  });

  it('is idempotent -- a second run never re-escalates an already-escalated suspension', async () => {
    const target = await signupBuilder('escalate-idempotent-target');
    const userId = await userIdFor(target);
    const pastGracePeriod = new Date(Date.now() - 1000).toISOString();
    const suspensionId = await insertSuspension(userId, { gracePeriodEndsAt: pastGracePeriod });

    await escalateExpiredSuspensions(env.DB);
    await escalateExpiredSuspensions(env.DB);

    const logCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('auto_escalate_suspension', userId).first();
    expect(logCount.count).toBe(1);
    const suspensionRow = await env.DB.prepare('SELECT escalated_at FROM account_suspensions WHERE suspension_id = ?')
      .bind(suspensionId).first();
    expect(suspensionRow.escalated_at).toBeTruthy();
  });

  it('re-arms (clears escalated_at) when cascadeDeleteAccount fails, and succeeds on a later retry (#2117)', async () => {
    const target = await signupBuilder('escalate-retry-target');
    const userId = await userIdFor(target);
    const pastGracePeriod = new Date(Date.now() - 1000).toISOString();
    const suspensionId = await insertSuspension(userId, { gracePeriodEndsAt: pastGracePeriod });

    // Forces cascadeDeleteAccount's own UPDATE to fail with a real UNIQUE
    // constraint violation: it always rewrites username to a deterministic
    // `deleted-<last 8 chars of user_id>` value (see its own comment), so a
    // decoy row already holding that exact username collides every time.
    const suffix = userId.slice(-8);
    const decoyUserId = `escalate-retry-decoy-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO users (user_id, email, username, password_hash)
      VALUES (?, ?, ?, 'x')
    `).bind(decoyUserId, `${decoyUserId}@example.com`, `deleted-${suffix}`).run();

    await escalateExpiredSuspensions(env.DB);

    // The whole batch (including the sessions DELETE) rolls back with the
    // failed UPDATE -- nothing about the account changed.
    const userRowAfterFailure = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
    expect(userRowAfterFailure.deleted_at).toBeNull();
    expect(userRowAfterFailure.email).toBe(target.email);
    const suspensionRowAfterFailure = await env.DB.prepare('SELECT escalated_at FROM account_suspensions WHERE suspension_id = ?')
      .bind(suspensionId).first();
    expect(suspensionRowAfterFailure.escalated_at).toBeNull();
    const logCountAfterFailure = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('auto_escalate_suspension', userId).first();
    expect(logCountAfterFailure.count).toBe(0);

    // Clear the collision and retry -- the re-armed suspension is due
    // again (escalated_at IS NULL), so the next run picks it right up.
    await env.DB.prepare('DELETE FROM users WHERE user_id = ?').bind(decoyUserId).run();
    await escalateExpiredSuspensions(env.DB);

    const userRowAfterRetry = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
    expect(userRowAfterRetry.deleted_at).toBeTruthy();
    const suspensionRowAfterRetry = await env.DB.prepare('SELECT escalated_at FROM account_suspensions WHERE suspension_id = ?')
      .bind(suspensionId).first();
    expect(suspensionRowAfterRetry.escalated_at).toBeTruthy();
    const logCountAfterRetry = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('auto_escalate_suspension', userId).first();
    expect(logCountAfterRetry.count).toBe(1);
  });
});
