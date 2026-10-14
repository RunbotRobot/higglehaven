// #2038: GET /builders?ids=... and GET /sellers?ids=... accept up to 200
// ids but used to bind them all in a single unchunked IN (...) query --
// D1 caps a single query at 100 bound parameters
// (developers.cloudflare.com/d1/platform/limits), so a value set between
// 101 and 200 ids threw a raw D1 error instead of returning data. Gets
// its own test file (seeding builders/sellers directly, same shape as
// assertReferencesExist's own #1978 test) rather than living in
// profiles.test.js, since profiles.test.js has other tests asserting an
// exact unpaginated builder/seller count that 150 extra seeded rows would
// otherwise break.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('GET /builders?ids=... and GET /sellers?ids=... past the 100-bound-parameter limit (#2038)', () => {
  it('does not throw a raw D1 error for GET /builders?ids=... with 150 ids', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `builder-ids-chunk-${i}`);
    await env.DB.batch(ids.map((id) => env.DB.prepare(
      'INSERT INTO builders (builder_id, label) VALUES (?, ?)',
    ).bind(id, id)));

    const result = await api(`/builders?ids=${ids.join(',')}`);
    expect(result.response.status).toBe(200);
    expect(result.body.builders.map((b) => b.builderId).sort()).toEqual([...ids].sort());
  });

  it('does not throw a raw D1 error for GET /sellers?ids=... with 150 ids', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `seller-ids-chunk-${i}`);
    await env.DB.batch(ids.map((id) => env.DB.prepare(
      'INSERT INTO sellers (seller_id, label) VALUES (?, ?)',
    ).bind(id, id)));

    const result = await api(`/sellers?ids=${ids.join(',')}`);
    expect(result.response.status).toBe(200);
    expect(result.body.sellers.map((s) => s.sellerId).sort()).toEqual([...ids].sort());
  });
});
