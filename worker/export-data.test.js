// #1984 (sub-issue of #1983, owner-greenlit on #1480): GET /api/auth/export-data,
// the foundational endpoint + identity/profile section of the GDPR/CCPA
// "right to access" companion to #1145's own "right to erasure". Later
// sub-issues (#1985 commerce/economy, #1986 social/content) add their own
// top-level keys to this same response shape -- this file only covers the
// `profile` section this issue itself ships.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, extractSessionCookie, signup, signupBuilder, withSession,
} from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('GET /auth/export-data (#1984)', () => {
  it('requires a session', async () => {
    const anon = await api('/auth/export-data');
    expect(anon.response.status).toBe(401);
  });

  it('returns the account and builder profile, with no seller profile yet', async () => {
    const account = await signupBuilder('export-data-builder');
    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.exportedAt).toBeTruthy();
    expect(result.body.profile.account.email).toBe(account.email);
    expect(result.body.profile.account.password_hash).toBeUndefined();
    expect(result.body.profile.builder.builderId).toBe(account.builderId);
    expect(result.body.profile.seller).toBeNull();
    expect(result.body.profile.diditVerificationSessions).toEqual([]);
  });

  it('includes the seller profile once one exists', async () => {
    const email = `export-data-seller-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password here', { username: 'export-data-seller' });
    const sessionToken = extractSessionCookie(signedUp.response);
    await api('/sellers/me', withSession(sessionToken));
    const result = await api('/auth/export-data', withSession(sessionToken));
    expect(result.response.status).toBe(200);
    expect(result.body.profile.seller).not.toBeNull();
    expect(result.body.profile.seller.label).toBe('export-data-seller');
  });

  it('includes didit verification sessions by status/timestamp only, never a raw payload', async () => {
    const account = await signupBuilder('export-data-didit');
    const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(account.email).first()).user_id;
    await env.DB.prepare(
      'INSERT INTO didit_verification_sessions (session_id, user_id, status, processed_at) VALUES (?, ?, ?, ?)',
    ).bind('didit-export-test-session', userId, 'approved', '2026-10-01T00:00:00.000Z').run();

    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.profile.diditVerificationSessions).toEqual([{
      sessionId: 'didit-export-test-session',
      status: 'approved',
      createdAt: expect.any(String),
      processedAt: '2026-10-01T00:00:00.000Z',
    }]);
  });

  it('rate-limits repeated calls from the same account', async () => {
    const account = await signupBuilder('export-data-rate-limit');
    for (let i = 0; i < 10; i += 1) {
      const attempt = await api('/auth/export-data', account.session());
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api('/auth/export-data', account.session());
    expect(limited.response.status).toBe(429);
  });
});
