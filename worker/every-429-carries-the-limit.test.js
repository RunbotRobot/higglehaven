// #4540 ("A message that limits or refuses an action states the limit and when it lifts"): the client builds its sentence
// from the numbers a 429 carries (src/rateLimitNotice.js, applied to every 429 by src/api.js), so a 429 thrown anywhere
// else, with no numbers, would read as a bare refusal. The one place that may answer 429 is rateLimitRefusal.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkRateLimit } from './lib/rate-limit.js';

const sources = import.meta.glob(['./index.js', './lib/*.js'], { query: '?raw', import: 'default', eager: true });

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('429 answers (#4540)', () => {
  it('only worker/lib/rate-limit.js answers 429', () => {
    const offenders = [];
    for (const [file, source] of Object.entries(sources)) {
      if (file.endsWith('/rate-limit.js')) continue;
      source.split('\n').forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/HttpError\([^)]*,\s*429\b/.test(code) || /status:\s*429\b/.test(code) || /\b429\s*,\s*\{/.test(code)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('a refused bucket answers with the limit, the window and the seconds until it lifts', async () => {
    const bucket = `every-429-test:${Date.now()}`;
    await checkRateLimit(env.DB, bucket, 1);
    const error = await checkRateLimit(env.DB, bucket, 1).then(() => null, (thrown) => thrown);
    expect(error?.status).toBe(429);
    expect(error.extra).toMatchObject({ limit: 1, windowSeconds: 900 });
    expect(error.extra.retryAfterSeconds).toBeGreaterThan(0);
  });
});
