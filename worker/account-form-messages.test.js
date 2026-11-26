// #4476: what sign-up says when it refuses what a person typed is written for the person (what to do), never the
// server's own phrasing ("email is not a valid email address", "password must be at least 8 characters").
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { signup } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const unique = () => `form-${crypto.randomUUID().slice(0, 8)}@example.com`;

describe('Sign-up refusals read in plain words (#4476)', () => {
  it('an address that is not an email', async () => {
    const result = await signup('not-an-email', 'a fine long password here');
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe('Enter an email address like name@example.com.');
  });

  it('a missing password, a short one and a very long one', async () => {
    const missing = await signup(unique(), undefined);
    expect(missing.response.status).toBe(400);
    expect(missing.body.error).toBe('Enter a password.');
    const short = await signup(unique(), 'short');
    expect(short.response.status).toBe(400);
    expect(short.body.error).toBe('Use at least 8 characters for your password.');
    const long = await signup(unique(), 'x'.repeat(201));
    expect(long.response.status).toBe(400);
    expect(long.body.error).toBe('Use 200 characters or fewer for your password.');
  });

  it('a missing name', async () => {
    const result = await signup(unique(), 'a fine long password here', { username: '   ' });
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe('Enter a name.');
  });
});
