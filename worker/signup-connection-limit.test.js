// #4472: sign-up answers a taken address with 409, so a connection could test any number of different
// addresses (the existing limit counts connection AND address). A second limit counts the connection alone.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP_CONNECTION_RATE_LIMIT_MAX } from './lib/auth-routes.js';
import { api } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const attempt = (n, ip) => api('/auth/signup', {
  method: 'POST',
  headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
  // ageAttested false: refused with 400 right after the limits, so no account is made and the attempt still counts.
  body: JSON.stringify({ email: `probe-${n}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: 'a fine long password here', username: `probe${n}x${crypto.randomUUID().slice(0, 4)}`, ageAttested: false }),
});

describe('sign-up limit per connection (#4472)', () => {
  it('lets a household sign up a few people, then answers the next different address with the limit and when it lifts', async () => {
    const ip = `203.0.113.${40 + Math.floor(Math.random() * 100)}`;
    for (let n = 0; n < SIGNUP_CONNECTION_RATE_LIMIT_MAX; n++) {
      expect((await attempt(n, ip)).response.status).toBe(400);
    }
    const refused = await attempt(SIGNUP_CONNECTION_RATE_LIMIT_MAX, ip);
    expect(refused.response.status).toBe(429);
    expect(refused.body.limit).toBe(SIGNUP_CONNECTION_RATE_LIMIT_MAX);
    expect(refused.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not count another connection', async () => {
    const other = `198.51.100.${40 + Math.floor(Math.random() * 100)}`;
    expect((await attempt(1, other)).response.status).toBe(400);
  });
});
