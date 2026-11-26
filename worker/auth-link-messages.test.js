// #4473, #4474, #4475: what a person is told when a log-in is locked, and when an emailed link no longer works.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signup } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('a locked log-in says when it lifts (#4473)', () => {
  it('gives the time left and points at Forgot password, with retryAfterSeconds', async () => {
    const email = `auth-lock-msg-${crypto.randomUUID()}@example.com`;
    await signup(email, 'the real correct password');
    for (let i = 0; i < 5; i++) {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'wrong every time' }) });
    }
    const locked = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'the real correct password' }) });
    expect(locked.response.status).toBe(423);
    expect(locked.body.error).toMatch(/about 15 minutes/);
    expect(locked.body.error).toMatch(/Forgot password/);
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(14 * 60);
    expect(locked.body.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });
});

describe('an emailed link that no longer works (#4474, #4475)', () => {
  it('a reset link that does not work carries its own code, so the client can offer a new one', async () => {
    const result = await api('/auth/reset-password', {
      method: 'POST', body: JSON.stringify({ token: 'f'.repeat(64), newPassword: 'a new long password' }),
    });
    expect(result.response.status).toBe(400);
    expect(result.body.code).toBe('reset_link_invalid');
  });

  it('a verification link that does not work carries its own code', async () => {
    const result = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: 'e'.repeat(64) }) });
    expect(result.response.status).toBe(400);
    expect(result.body.code).toBe('verify_link_invalid');
  });

  it('a verification link used twice is a success the second time for an address that is verified', async () => {
    const signedUp = await signup(`auth-verify-twice-${crypto.randomUUID()}@example.com`, 'a fine long password');
    const token = /verifyEmail=([0-9a-f]{64})$/.exec(signedUp.body.devVerifyUrl)[1];
    const first = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
    expect(first.response.status).toBe(200);
    expect(first.body.alreadyVerified).toBeUndefined();
    const second = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
    expect(second.response.status).toBe(200);
    expect(second.body).toMatchObject({ verified: true, alreadyVerified: true });
  });
});
