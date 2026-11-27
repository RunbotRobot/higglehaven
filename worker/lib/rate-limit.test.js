// #4542: the counter limiter used by the polling buckets.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMIT_WINDOW_MS, checkPollRateLimit, rateLimitWindowStart } from './rate-limit.js';

const rowFor = (bucket) => env.DB.prepare('SELECT window_start, count FROM rate_limit_counters WHERE bucket_key = ?').bind(bucket).first();

describe('checkPollRateLimit', () => {
  beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

  it('counts in one row and refuses at the limit with the 429 numbers', async () => {
    const bucket = `poll-test:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i += 1) await checkPollRateLimit(env.DB, bucket, 3);
    expect((await rowFor(bucket)).count).toBe(3);
    const err = await checkPollRateLimit(env.DB, bucket, 3).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.extra).toMatchObject({ limit: 3, windowSeconds: RATE_LIMIT_WINDOW_MS / 1000 });
    expect((await rowFor(bucket)).count).toBe(3);
  });

  it('starts a fresh count when the window has passed', async () => {
    const bucket = `poll-test:${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO rate_limit_counters (bucket_key, window_start, count) VALUES (?, ?, 5)')
      .bind(bucket, rateLimitWindowStart() - RATE_LIMIT_WINDOW_MS).run();
    await checkPollRateLimit(env.DB, bucket, 5);
    const row = await rowFor(bucket);
    expect(row.count).toBe(1);
    expect(row.window_start).toBe(rateLimitWindowStart());
  });

  it('retryAfterSeconds is the time left in the window', async () => {
    const bucket = `poll-test:${crypto.randomUUID()}`;
    await checkPollRateLimit(env.DB, bucket, 1);
    const err = await checkPollRateLimit(env.DB, bucket, 1).catch((e) => e);
    const retry = err.extra.retryAfterSeconds;
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS / 1000);
  });
});
