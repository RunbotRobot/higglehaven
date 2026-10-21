// #1978: assertReferencesExist used to bind one parameter per unique
// value in a single query, with no chunking -- D1 caps a single query at
// 100 bound parameters (developers.cloudflare.com/d1/platform/limits), so
// any caller whose deduplicated value set exceeded that threw a raw D1
// error instead of this function's own clean "does not exist" message.
// Tested directly against the exported primitive (same "no real HTTP
// caller needed to exercise a pure DB helper" shape card-fingerprint.test.js's
// own claimCardFingerprint tests already use) against the `sellers` table,
// since it's the lightest real table with no FK constraints to seed.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertReferencesExist } from './lib/validation.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function seedSellers(count, prefix) {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
  await env.DB.batch(ids.map((id) => env.DB.prepare(
    'INSERT INTO sellers (seller_id, label) VALUES (?, ?)',
  ).bind(id, id)));
  return ids;
}

describe('assertReferencesExist (#1978)', () => {
  it('does not throw a raw D1 error for a value set past the 100-bound-parameter limit when every value is real', async () => {
    const ids = await seedSellers(150, 'assert-refs-all-real');
    await expect(assertReferencesExist(env.DB, 'sellers', 'seller_id', ids, 'sellerId')).resolves.toBeUndefined();
  });

  it('still detects a missing value that falls in a later chunk, not just the first 100', async () => {
    const ids = await seedSellers(150, 'assert-refs-missing-in-second-chunk');
    // Index 120 -- past the first 100-value chunk -- replaced with an id
    // that was never inserted.
    const withOneMissing = [...ids];
    withOneMissing[120] = 'assert-refs-missing-in-second-chunk-does-not-exist';
    await expect(
      assertReferencesExist(env.DB, 'sellers', 'seller_id', withOneMissing, 'sellerId'),
    ).rejects.toThrow('sellerId "assert-refs-missing-in-second-chunk-does-not-exist" does not exist');
  });

  it('still works for a value set at or under the limit (no regression on the common case)', async () => {
    const ids = await seedSellers(5, 'assert-refs-small');
    await expect(assertReferencesExist(env.DB, 'sellers', 'seller_id', ids, 'sellerId')).resolves.toBeUndefined();

    await expect(
      assertReferencesExist(env.DB, 'sellers', 'seller_id', [...ids, 'assert-refs-small-missing'], 'sellerId'),
    ).rejects.toThrow('sellerId "assert-refs-small-missing" does not exist');
  });
});
