// #3464: requireCurrentUser reads the session, its user and the account's
// suspension standing in one statement. These pin that the refusal is exactly
// what it was when the standing was a second query: an active suspension
// refuses with the distinct suspended error, a lifted or escalated one does
// not, and the user object handed to handlers carries no extra column.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function suspend(userId, { lifted = false, escalated = false } = {}) {
  await env.DB.prepare(`
    INSERT INTO account_suspensions
      (suspension_id, user_id, admin_user_id, reason, grace_period_ends_at, lifted_at, escalated_at)
    VALUES (?, ?, 'admin-x', 'test', '2999-01-01T00:00:00.000Z', ?, ?)
  `).bind(
    `susp-${crypto.randomUUID()}`, userId,
    lifted ? '2026-01-01T00:00:00.000Z' : null,
    escalated ? '2026-01-01T00:00:00.000Z' : null,
  ).run();
}

describe('session read carries suspension standing (#3464)', () => {
  it('an account in good standing is let through, and the user has no standing column', async () => {
    const builder = await signupBuilder('standing-good');
    const me = await api('/auth/me', builder.session());
    expect(me.response.status).toBe(200);
    expect(JSON.stringify(me.body)).not.toContain('suspended_standing');
  });

  it('an active suspension is refused with the suspended error', async () => {
    const builder = await signupBuilder('standing-suspended');
    const before = await api('/auth/me', builder.session());
    await suspend(before.body.user.userId);
    const refused = await api('/builders/me', builder.session());
    expect(refused.response.status).toBe(403);
    expect(refused.body.suspended).toBe(true);
  });

  it('a lifted suspension no longer refuses', async () => {
    const builder = await signupBuilder('standing-lifted');
    const before = await api('/auth/me', builder.session());
    await suspend(before.body.user.userId, { lifted: true });
    const ok = await api('/builders/me', builder.session());
    expect(ok.response.status).toBe(200);
  });

  it('an escalated suspension no longer refuses (the closure path owns it)', async () => {
    const builder = await signupBuilder('standing-escalated');
    const before = await api('/auth/me', builder.session());
    await suspend(before.body.user.userId, { escalated: true });
    const ok = await api('/builders/me', builder.session());
    expect(ok.response.status).toBe(200);
  });

  it('a missing session is still a plain 401', async () => {
    const anonymous = await api('/builders/me');
    expect(anonymous.response.status).toBe(401);
  });
});
